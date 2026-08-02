import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { playerClaims, players, tournaments, user, type Db } from '@smashclub/db';
import { appRouter } from '../src/trpc/router';
import type { TrpcContext } from '../src/trpc/trpc';
import { loadEnv } from '../src/env';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { importRegistryPlayers, registerTournamentSlugs } from '../src/bootstrap/importRegistry';
import { syncTournament } from '../src/sync/sync';
import { runRecompute } from '../src/recompute/recompute';
import { createTestDb } from './helpers/testDb';
import { fixtureClient, type FixtureTournament } from './helpers/challongeFixtures';

/**
 * The club publishes aliases, not the registry's record of who people are.
 *
 * These tests read every public route's whole serialised response rather than
 * named fields, because the failure this guards against is a *field that should
 * not be there* — a column added to a select and spread into a response. An
 * assertion on the fields we already know about could not have caught that.
 */

let db: Db;
let close: () => Promise<void>;

const SURNAMES = ['McCloud', 'Aran', 'Lombardi'];

const fixture: FixtureTournament = {
  slug: 'weekly1',
  state: 'complete',
  participants: [
    { id: 1, name: '[ATL] Fox McCloud', seed: 1, finalRank: 1 },
    { id: 2, name: '[ATL] Samus Aran', seed: 2, finalRank: 2 },
    // Nothing in the registry matches, so this one stays unresolved: a bracket
    // entry the review queue has not reached yet, and the only public name with
    // no player row behind it.
    { id: 3, name: 'Falco Lombardi', seed: 3, finalRank: 3 },
  ],
  matches: [
    { id: 11, p1: 1, p2: 2, winner: 1, order: 1 },
    { id: 12, p1: 1, p2: 3, winner: 1, order: 2 },
    { id: 13, p1: 2, p2: 3, winner: 2, order: 3 },
  ],
};

function callerFor(sessionUser: TrpcContext['user']) {
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://unused',
    BETTER_AUTH_SECRET: 'test-secret-test-secret-test',
  });
  return appRouter.createCaller({
    db,
    env,
    user: sessionUser,
    challonge: fixtureClient([fixture]),
    recomputeTrigger: new RecomputeTrigger(db, 1_000_000),
  });
}

/** What an anonymous visitor gets. */
const anonymous = () => callerFor(null);

async function playerId(canonicalName: string): Promise<string> {
  const [row] = await db.select({ id: players.id }).from(players).where(eq(players.canonicalName, canonicalName));
  return row!.id;
}

/** Fails naming the offending surname and the payload it appeared in. */
function expectNoFullNames(label: string, payload: unknown): void {
  const body = JSON.stringify(payload);
  for (const surname of SURNAMES) {
    expect(body, `${label} published the surname “${surname}”`).not.toContain(surname);
  }
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await importRegistryPlayers(db, [
    { id: 'fox', canonical_name: 'Fox McCloud', company: 'ATL' },
    { id: 'samus', canonical_name: 'Samus Aran', company: 'ATL' },
  ]);
  await registerTournamentSlugs(db, ['weekly1']);
  const [row] = await db.select({ id: tournaments.id }).from(tournaments).where(eq(tournaments.challongeSlug, 'weekly1'));
  await syncTournament(db, fixtureClient([fixture]), row!.id);
  await runRecompute(db);
});

afterEach(async () => {
  await close();
});

describe('public routes publish aliases, never canonical names', () => {
  it('leaderboard', async () => {
    const board = await anonymous().public.leaderboard();
    expect(board.rows.map((row) => row.name).sort()).toEqual(['Fox M', 'Samus A']);
    expectNoFullNames('public.leaderboard', board);
  });

  it('player profile, including its opponents', async () => {
    const profile = await anonymous().public.player({ playerId: await playerId('Fox McCloud') });
    if (profile === null || profile.player === undefined) throw new Error('expected a player profile');
    expect(profile.player.name).toBe('Fox M');
    // The opponent join is the easy one to miss: it names a *different* player.
    expect(profile.events.map((event) => event.opponentName)).toContain('Samus A');
    expectNoFullNames('public.player', profile);
  });

  it('rating history', async () => {
    const history = await anonymous().public.ratingHistory();
    expect(history.players.map((row) => row.name).sort()).toEqual(['Fox M', 'Samus A']);
    expectNoFullNames('public.ratingHistory', history);
  });

  it('tournament detail, down to the unresolved bracket entry', async () => {
    const tournament = await anonymous().public.tournament({ slug: 'weekly1' });
    const names = tournament!.participants.map((p) => p.name).sort();
    // "Falco Lombardi" has no player row to carry an alias, so the same
    // shortening is applied to what the entrant typed into Challonge.
    expect(names).toEqual(['Falco L', 'Fox M', 'Samus A']);
    expectNoFullNames('public.tournament', tournament);
  });

  it('recap — the surface that gets shared outside the club', async () => {
    const recap = await anonymous().public.recap({ slug: 'weekly1' });
    expect(recap).not.toBeNull();
    expectNoFullNames('public.recap', recap);
  });

  it('search, which matches the board name rather than the registry one', async () => {
    const caller = anonymous();

    expect((await caller.public.searchPlayers({ query: 'Fox' })).map((row) => row.name)).toEqual(['Fox M']);
    // Case-insensitive, and a partial alias still finds the player, so someone
    // claiming their own profile has something to type.
    expect((await caller.public.searchPlayers({ query: 'samus a' })).map((row) => row.name)).toEqual(['Samus A']);

    // The point of the change: a surname is not a query. Were it still matched,
    // an empty result for one guess and a hit for the next would reconstruct
    // the registry a probe at a time without ever returning a canonical name.
    expect(await caller.public.searchPlayers({ query: 'McCloud' })).toEqual([]);
    expect(await caller.public.searchPlayers({ query: 'Aran' })).toEqual([]);

    expectNoFullNames('public.searchPlayers', await caller.public.searchPlayers({ query: 'a' }));
  });

  it('finds a player by their chosen alias once they set one', async () => {
    await db.update(players).set({ displayName: 'starfox' }).where(eq(players.canonicalName, 'Fox McCloud'));
    const results = await anonymous().public.searchPlayers({ query: 'starf' });
    expect(results.map((row) => row.name)).toEqual(['starfox']);
    // The derived alias is replaced by the chosen one, not offered alongside it.
    expect(await anonymous().public.searchPlayers({ query: 'Fox M' })).toEqual([]);
  });
});

describe('me.claims', () => {
  beforeEach(async () => {
    await db.insert(user).values({ id: 'user-1', name: 'A User', email: 'user@example.com', role: 'user' });
  });

  it('does not name the player a pending claim points at', async () => {
    // Anyone may request a claim on anyone, so this route must not become a
    // lookup: request, read the name, withdraw.
    const me = callerFor({ id: 'user-1', email: 'user@example.com', name: 'A User', role: 'user' }).me;
    await me.requestClaim({ playerId: await playerId('Samus Aran') });

    const claims = await me.claims();
    expect(claims).toHaveLength(1);
    expect(claims[0]!.playerName).toBe('Samus A');
    expectNoFullNames('me.claims', claims);
  });

  it('offers the derived alias as the default an approved claimant falls back to', async () => {
    const me = callerFor({ id: 'user-1', email: 'user@example.com', name: 'A User', role: 'user' }).me;
    const { claimId } = await me.requestClaim({ playerId: await playerId('Samus Aran') });
    await db.update(playerClaims).set({ status: 'approved' }).where(eq(playerClaims.id, claimId));

    const [claim] = await me.claims();
    // What the profile editor shows as the placeholder — clearing the alias
    // field falls back to this, and it is the shortened form, not the registry
    // name it was shortened from.
    expect(claim!.defaultAlias).toBe('Samus A');
    expectNoFullNames('me.claims', claim);
  });
});
