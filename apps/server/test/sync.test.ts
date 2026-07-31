import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { reviewItems, sets, tournamentParticipants, tournaments, type Db } from '@smashclub/db';
import { importRegistryPlayers, registerTournamentSlugs } from '../src/bootstrap/importRegistry';
import { syncTournament } from '../src/sync/sync';
import { createTestDb } from './helpers/testDb';
import { fixtureClient, type FixtureTournament } from './helpers/challongeFixtures';

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await importRegistryPlayers(db, [
    { id: 'fox-mccloud', canonical_name: 'Fox McCloud', company: 'ATL', aliases: ['Fox'] },
    { id: 'samus-aran', canonical_name: 'Samus Aran', company: 'ATL', aliases: [] },
  ]);
  await registerTournamentSlugs(db, ['weekly1']);
});

afterEach(async () => {
  await close();
});

const baseFixture: FixtureTournament = {
  slug: 'weekly1',
  id: 4242,
  name: 'Weekly #1',
  state: 'complete',
  participants: [
    { id: 1, name: '[ATL] Fox McCloud', seed: 1, finalRank: 1 },
    { id: 2, name: '[Atlas] Samus Aran', seed: 2, finalRank: 2 },
    { id: 3, name: 'Falco Lombardi', seed: 3, finalRank: 3 },
  ],
  matches: [
    { id: 11, p1: 1, p2: 2, winner: 1, order: 1 },
    { id: 12, p1: 1, p2: 3, winner: 1, order: 2 },
    // Forfeit: negative score marks a DQ, excluded from ratings by default.
    { id: 13, p1: 2, p2: 3, winner: 2, order: 3, scores: '-1-0' },
  ],
};

async function tournamentId(): Promise<string> {
  const [row] = await db.select({ id: tournaments.id }).from(tournaments).where(eq(tournaments.challongeSlug, 'weekly1'));
  return row!.id;
}

describe('syncTournament', () => {
  it('imports participants and sets, auto-links known players, queues unknowns', async () => {
    const result = await syncTournament(db, fixtureClient([baseFixture]), await tournamentId());

    expect(result.participantsUpserted).toBe(3);
    expect(result.setsUpserted).toBe(3);
    expect(result.queuedForReview).toBe(1);

    const participants = await db.select().from(tournamentParticipants);
    const byName = new Map(participants.map((p) => [p.rawName, p]));
    // Registry players auto-link through aliases (company-tagged or aliased spelling).
    expect(byName.get('[ATL] Fox McCloud')!.playerId).not.toBeNull();
    expect(byName.get('[Atlas] Samus Aran')!.playerId).not.toBeNull();
    // Unknown player goes to the review queue, not auto-created.
    expect(byName.get('Falco Lombardi')!.playerId).toBeNull();

    const queue = await db.select().from(reviewItems);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.cleanedName).toBe('Falco Lombardi');
    expect(queue[0]!.status).toBe('pending');

    const setRows = await db.select().from(sets);
    expect(setRows).toHaveLength(3);
    const forfeit = setRows.find((s) => s.challongeMatchId === 13)!;
    expect(forfeit.excludedFromRatings).toBe(true);
    const normal = setRows.find((s) => s.challongeMatchId === 11)!;
    expect(normal.excludedFromRatings).toBe(false);
    // Resolved players are denormalised onto sets.
    expect(normal.p1PlayerId).not.toBeNull();
    expect(normal.p2PlayerId).not.toBeNull();

    const [tournament] = await db.select().from(tournaments);
    expect(tournament!.syncState).toBe('synced');
    expect(tournament!.challongeId).toBe(4242);
    expect(tournament!.eventDate).not.toBeNull();
  });

  it('is idempotent: running twice creates no duplicates', async () => {
    const client = fixtureClient([baseFixture]);
    const id = await tournamentId();
    await syncTournament(db, client, id);
    const second = await syncTournament(db, client, id);

    expect(second.setsChanged).toBe(0);
    expect(await db.select().from(tournamentParticipants)).toHaveLength(3);
    expect(await db.select().from(sets)).toHaveLength(3);
    expect(await db.select().from(reviewItems)).toHaveLength(1);
  });

  it('flows upstream score amendments through on re-sync', async () => {
    const id = await tournamentId();
    await syncTournament(db, fixtureClient([baseFixture]), id);

    const amended: FixtureTournament = {
      ...baseFixture,
      matches: baseFixture.matches.map((m) => (m.id === 11 ? { ...m, winner: 2, scores: '1-2' } : m)),
    };
    const result = await syncTournament(db, fixtureClient([amended]), id);
    expect(result.setsChanged).toBe(1);

    const [set] = await db.select().from(sets).where(eq(sets.challongeMatchId, 11));
    expect(set!.winner).toBe(2);
  });

  it('respects a manual exclusion override on re-sync', async () => {
    const id = await tournamentId();
    await syncTournament(db, fixtureClient([baseFixture]), id);

    // Admin includes the forfeit set manually.
    await db
      .update(sets)
      .set({ excludedFromRatings: false, exclusionManual: true })
      .where(eq(sets.challongeMatchId, 13));

    const amended: FixtureTournament = {
      ...baseFixture,
      matches: baseFixture.matches.map((m) => (m.id === 13 ? { ...m, scores: '-1-1' } : m)),
    };
    await syncTournament(db, fixtureClient([amended]), id);

    const [forfeit] = await db.select().from(sets).where(eq(sets.challongeMatchId, 13));
    expect(forfeit!.excludedFromRatings).toBe(false);
    expect(forfeit!.exclusionManual).toBe(true);
  });

  /**
   * Regression guard. `underway` used to map to syncState 'live', which the
   * scheduler fast-polled every 15s forever. Challonge's `underway` is sticky —
   * tournaments abandoned years ago still report it — so dead brackets were
   * polled indefinitely, exhausting the free tier's 500 requests/month in about
   * 40 minutes. Liveness is now explicit and expiring (`liveUntil`).
   */
  it('does NOT infer live monitoring from an underway state', async () => {
    const id = await tournamentId();
    const live: FixtureTournament = { ...baseFixture, state: 'underway', completedAt: null };
    await syncTournament(db, fixtureClient([live]), id);
    const [tournament] = await db.select().from(tournaments);
    expect(tournament!.syncState).toBe('registered');
    expect(tournament!.liveUntil).toBeNull();
  });

  it('keeps an open live window while the bracket is unfinished', async () => {
    const id = await tournamentId();
    const liveUntil = new Date(Date.now() + 60 * 60 * 1000);
    await db.update(tournaments).set({ liveUntil }).where(eq(tournaments.id, id));

    const unfinished: FixtureTournament = { ...baseFixture, state: 'underway', completedAt: null };
    await syncTournament(db, fixtureClient([unfinished]), id);

    const [tournament] = await db.select().from(tournaments);
    expect(tournament!.liveUntil?.toISOString()).toBe(liveUntil.toISOString());
  });

  it('closes the live window as soon as the bracket completes', async () => {
    const id = await tournamentId();
    await db
      .update(tournaments)
      .set({ liveUntil: new Date(Date.now() + 60 * 60 * 1000) })
      .where(eq(tournaments.id, id));

    // baseFixture is a completed tournament.
    await syncTournament(db, fixtureClient([baseFixture]), id);

    const [tournament] = await db.select().from(tournaments);
    expect(tournament!.syncState).toBe('synced');
    // Without this the poller would keep going until the window ran out.
    expect(tournament!.liveUntil).toBeNull();
  });
});
