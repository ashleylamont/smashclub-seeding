import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  companies,
  playerAliases,
  playerCharacters,
  players,
  reviewItems,
  tournaments,
  user,
  type Db,
} from '@smashclub/db';
import { appRouter } from '../src/trpc/router';
import type { TrpcContext } from '../src/trpc/trpc';
import { loadEnv } from '../src/env';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { importRegistryPlayers, registerTournamentSlugs } from '../src/bootstrap/importRegistry';
import { syncTournament } from '../src/sync/sync';
import { charactersForPlayer, setPlayerCharacters } from '../src/players/characters';
import { createTestDb } from './helpers/testDb';
import { fixtureClient, type FixtureTournament } from './helpers/challongeFixtures';

let db: Db;
let close: () => Promise<void>;
let admin: ReturnType<typeof appRouter.createCaller>['admin'];

const fixture: FixtureTournament = {
  slug: 'weekly1',
  state: 'complete',
  participants: [
    { id: 1, name: '[ATL] Fox McCloud' },
    { id: 2, name: '[ATL] Samus Aran' },
    { id: 3, name: 'Falco Lombardi' },
  ],
  matches: [
    { id: 11, p1: 1, p2: 2, winner: 1, order: 1 },
    { id: 12, p1: 1, p2: 3, winner: 1, order: 2 },
  ],
};

/** An admin caller over the real router, so input validation is exercised too. */
function callerFor(user: TrpcContext['user']) {
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://unused',
    BETTER_AUTH_SECRET: 'test-secret-test-secret-test',
  });
  return appRouter.createCaller({
    db,
    env,
    user,
    challonge: fixtureClient([fixture]),
    // Debounced far past the end of any test, so nothing recomputes underneath.
    recomputeTrigger: new RecomputeTrigger(db, 1_000_000),
  });
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await importRegistryPlayers(db, [
    { id: 'fox', canonical_name: 'Fox McCloud', company: 'ATL' },
    { id: 'samus', canonical_name: 'Samus Aran', company: 'ATL' },
  ]);
  // Resolutions stamp `resolvedBy`, which is a FK onto user.
  await db.insert(user).values({ id: 'admin-1', name: 'Admin', email: 'admin@example.com', role: 'admin' });
  admin = callerFor({ id: 'admin-1', email: 'admin@example.com', name: 'Admin', role: 'admin' }).admin;
});

afterEach(async () => {
  await close();
});

describe('player characters', () => {
  it('round-trips in the order they were chosen', async () => {
    const [fox] = await db.select().from(players).where(eq(players.legacyId, 'fox'));
    await setPlayerCharacters(db, fox!.id, ['falco', 'fox', 'wolf']);
    expect(await charactersForPlayer(db, fox!.id)).toEqual(['falco', 'fox', 'wolf']);
  });

  it('replaces rather than accumulates, so removals stick', async () => {
    const [fox] = await db.select().from(players).where(eq(players.legacyId, 'fox'));
    await setPlayerCharacters(db, fox!.id, ['falco', 'fox']);
    await setPlayerCharacters(db, fox!.id, ['wolf']);
    expect(await charactersForPlayer(db, fox!.id)).toEqual(['wolf']);

    await setPlayerCharacters(db, fox!.id, []);
    expect(await db.select().from(playerCharacters).where(eq(playerCharacters.playerId, fox!.id))).toHaveLength(0);
  });

  it('rejects unknown slugs, duplicates and over-long lists', async () => {
    const [fox] = await db.select().from(players).where(eq(players.legacyId, 'fox'));
    await expect(admin.updatePlayer({ playerId: fox!.id, characters: ['not-a-fighter'] })).rejects.toThrow();
    await expect(admin.updatePlayer({ playerId: fox!.id, characters: ['fox', 'fox'] })).rejects.toThrow();
    await expect(
      admin.updatePlayer({ playerId: fox!.id, characters: ['fox', 'falco', 'wolf', 'ike', 'marth'] }),
    ).rejects.toThrow();
  });
});

describe('admin.createPlayer', () => {
  it('stores details and aliases the registry name for future imports', async () => {
    const { playerId } = await admin.createPlayer({
      canonicalName: 'Ashley Lamont',
      displayName: 'ashl',
      companyCode: 'ATL',
      characters: ['pyra', 'mythra'],
      aliases: ['Ash L'],
    });

    const [player] = await db.select().from(players).where(eq(players.id, playerId));
    expect(player!.canonicalName).toBe('Ashley Lamont');
    expect(player!.displayName).toBe('ashl');
    expect(player!.companyId).not.toBeNull();
    expect(await charactersForPlayer(db, playerId)).toEqual(['pyra', 'mythra']);

    const aliases = await db.select().from(playerAliases).where(eq(playerAliases.playerId, playerId));
    expect(aliases.map((row) => row.aliasNorm).sort()).toEqual(['ash l', 'ashley lamont']);
  });

  it('refuses a public alias another player already publishes', async () => {
    await admin.createPlayer({ canonicalName: 'One', displayName: 'Wolf', companyCode: null, characters: [], aliases: [] });
    await expect(
      admin.createPlayer({ canonicalName: 'Two', displayName: 'wolf', companyCode: null, characters: [], aliases: [] }),
    ).rejects.toThrow(/already taken/i);
  });

  it('rejects an unknown company rather than silently dropping it', async () => {
    await expect(
      admin.createPlayer({ canonicalName: 'Three', displayName: null, companyCode: 'NOPE', characters: [], aliases: [] }),
    ).rejects.toThrow(/Unknown company/);
  });
});

describe('review queue details', () => {
  async function queueFalco(): Promise<string> {
    await registerTournamentSlugs(db, ['weekly1']);
    const [row] = await db.select({ id: tournaments.id }).from(tournaments).where(eq(tournaments.challongeSlug, 'weekly1'));
    await syncTournament(db, fixtureClient([fixture]), row!.id);
    const [item] = await db.select().from(reviewItems).where(eq(reviewItems.status, 'pending'));
    return item!.id;
  }

  it('applies details when creating a player from a bracket entry', async () => {
    const reviewItemId = await queueFalco();
    const { playerId } = await admin.resolveReview({
      reviewItemId,
      resolution: {
        kind: 'created_new',
        details: {
          canonicalName: 'Falco L',
          displayName: 'birb',
          companyCode: 'ATL',
          characters: ['falco'],
        },
      },
    });

    const [player] = await db.select().from(players).where(eq(players.id, playerId));
    expect(player!.canonicalName).toBe('Falco L');
    expect(player!.displayName).toBe('birb');
    expect(await charactersForPlayer(db, playerId)).toEqual(['falco']);

    // The bracket's own spelling stays aliased, so the next import of
    // "Falco Lombardi" links silently instead of queueing again.
    const aliases = await db.select().from(playerAliases).where(eq(playerAliases.playerId, playerId));
    expect(aliases.map((row) => row.aliasNorm)).toContain('falco lombardi');
    expect(aliases.map((row) => row.aliasNorm)).toContain('falco l');
  });

  it('still resolves with no details at all', async () => {
    const reviewItemId = await queueFalco();
    const { playerId } = await admin.resolveReview({ reviewItemId, resolution: { kind: 'created_new' } });

    const [player] = await db.select().from(players).where(eq(players.id, playerId));
    expect(player!.canonicalName).toBe('Falco Lombardi');
    expect(player!.displayName).toBeNull();
    expect(await charactersForPlayer(db, playerId)).toEqual([]);
  });
});

// The registry import seeds the default taxonomy (ATL, CAN, WOW, ...), so
// these use codes that no default holds.
describe('company management', () => {
  it('creates, renames its code, and reports player counts', async () => {
    const { companyId } = await admin.upsertCompany({ code: 'zed', name: 'Zed Corp', aliases: ['Zedd'] });

    let list = await admin.companies();
    const zed = list.find((row) => row.code === 'ZED')!;
    expect(zed.name).toBe('Zed Corp');
    // Aliases are normalised on the way in so case variants cannot become two rows.
    expect(zed.aliases).toEqual(['zedd']);
    expect(zed.playerCount).toBe(0);

    // Renaming the *code* is the case the old code-keyed upsert could not do.
    await admin.upsertCompany({ id: companyId, code: 'ZDC', name: 'Zed Corp Pty' });
    list = await admin.companies();
    expect(list.find((row) => row.code === 'ZED')).toBeUndefined();
    expect(list.find((row) => row.code === 'ZDC')!.name).toBe('Zed Corp Pty');

    await admin.createPlayer({ canonicalName: 'Someone', displayName: null, companyCode: 'ZDC', characters: [], aliases: [] });
    list = await admin.companies();
    expect(list.find((row) => row.code === 'ZDC')!.playerCount).toBe(1);
  });

  it('refuses to take a code another company already holds', async () => {
    const { companyId } = await admin.upsertCompany({ code: 'ZED', name: 'Zed Corp' });
    await admin.upsertCompany({ code: 'ZAP', name: 'Zap Ltd' });
    await expect(admin.upsertCompany({ id: companyId, code: 'ZAP', name: 'Zed Corp' })).rejects.toThrow(
      /already in use/,
    );
  });

  it('removes an alias without touching the company', async () => {
    const { companyId } = await admin.upsertCompany({ code: 'ZIG', name: 'Zig Inc', aliases: ['ziggy', 'zig inc'] });
    await admin.removeCompanyAlias({ companyId, alias: 'ziggy' });
    const list = await admin.companies();
    expect(list.find((row) => row.code === 'ZIG')!.aliases).toEqual(['zig inc']);
  });

  it('untags players when a company is deleted, keeping the players', async () => {
    const { companyId } = await admin.upsertCompany({ code: 'TMP', name: 'Temp' });
    const { playerId } = await admin.createPlayer({
      canonicalName: 'Tagged',
      displayName: null,
      companyCode: 'TMP',
      characters: [],
      aliases: [],
    });

    await admin.deleteCompany({ companyId });

    const [player] = await db.select().from(players).where(eq(players.id, playerId));
    expect(player).toBeDefined();
    expect(player!.companyId).toBeNull();
    expect(await db.select().from(companies).where(eq(companies.id, companyId))).toHaveLength(0);
  });
});

describe('self-service profile edits', () => {
  it('refuses character edits from a user without an approved claim', async () => {
    const [fox] = await db.select().from(players).where(eq(players.legacyId, 'fox'));
    const stranger = callerFor({ id: 'user-1', email: 'user@example.com', name: 'User', role: 'user' }).me;
    await expect(stranger.updateCharacters({ playerId: fox!.id, characters: ['fox'] })).rejects.toThrow(
      /not claimed/i,
    );
  });
});
