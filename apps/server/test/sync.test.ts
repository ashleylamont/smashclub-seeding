import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { ratingEvents, reviewItems, sets, tournamentParticipants, tournaments, type Db } from '@smashclub/db';
import { importRegistryPlayers, registerTournamentSlugs } from '../src/bootstrap/importRegistry';
import { syncTournament } from '../src/sync/sync';
import { runRecompute, latestRecomputeId } from '../src/recompute/recompute';
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

  it('imports a match completed after the roster was already resolved', async () => {
    const id = await tournamentId();
    const pending: FixtureTournament = {
      ...baseFixture,
      matches: baseFixture.matches.map((match) =>
        match.id === 11 ? { ...match, state: 'pending', winner: null, scores: null } : match,
      ),
    };
    await syncTournament(db, fixtureClient([pending]), id);
    const [before] = await db.select().from(sets).where(eq(sets.challongeMatchId, 11));
    expect(before!.state).toBe('pending');
    expect(before!.winner).toBeNull();

    const completed = {
      ...pending,
      matches: [
        ...pending.matches.map((match) =>
          match.id === 11 ? { ...match, state: 'complete', winner: 1, scores: '2-0' } : match,
        ),
        // A result can appear after the initial roster sync without changing
        // any existing match row; it must still be inserted and rated.
        { id: 14, p1: 1, p2: 2, winner: 2, order: 4, scores: '2-1' },
      ],
    };
    const result = await syncTournament(db, fixtureClient([completed]), id);
    expect(result.setsChanged).toBe(2);
    const [after] = await db.select().from(sets).where(eq(sets.challongeMatchId, 11));
    expect(after!.state).toBe('complete');
    expect(after!.winner).toBe(1);
    const [newResult] = await db.select().from(sets).where(eq(sets.challongeMatchId, 14));
    expect(newResult!.state).toBe('complete');
    expect(newResult!.winner).toBe(2);
  });

  it('detects a changed opponent even when score and winner side stay the same', async () => {
    const id = await tournamentId();
    await syncTournament(db, fixtureClient([baseFixture]), id);
    const [original] = await db.select().from(sets).where(eq(sets.challongeMatchId, 11));
    const amended: FixtureTournament = {
      ...baseFixture,
      matches: baseFixture.matches.map((match) =>
        match.id === 11 ? { ...match, p2: 3, winner: 1 } : match,
      ),
    };
    const result = await syncTournament(db, fixtureClient([amended]), id);
    expect(result.setsChanged).toBe(1);
    const [updated] = await db.select().from(sets).where(eq(sets.challongeMatchId, 11));
    expect(updated!.p1ParticipantId).toBe(original!.p1ParticipantId);
    expect(updated!.p2ParticipantId).not.toBe(original!.p2ParticipantId);
    expect(updated!.winner).toBe(original!.winner);
    expect(updated!.scoresCsv).toBe(original!.scoresCsv);
  });

  it('repairs denormalized participant links on an unchanged re-sync', async () => {
    const id = await tournamentId();
    await syncTournament(db, fixtureClient([baseFixture]), id);
    const [original] = await db.select().from(sets).where(eq(sets.challongeMatchId, 11));
    expect(original!.p1PlayerId).not.toBeNull();
    expect(original!.p2PlayerId).not.toBeNull();
    await db
      .update(sets)
      .set({ p1PlayerId: null, p2PlayerId: null })
      .where(eq(sets.challongeMatchId, 11));

    const result = await syncTournament(db, fixtureClient([baseFixture]), id);
    expect(result.setsChanged).toBeGreaterThan(0);
    const [repaired] = await db.select().from(sets).where(eq(sets.challongeMatchId, 11));
    expect(repaired!.p1PlayerId).toBe(original!.p1PlayerId);
    expect(repaired!.p2PlayerId).toBe(original!.p2PlayerId);
  });

  it('persists both result stages while final-stage-only policy controls ratings', async () => {
    const id = await tournamentId();
    const staged: FixtureTournament = {
      ...baseFixture,
      matches: [
        { id: 21, p1: 1, p2: 2, winner: 1, order: 1, stage: 'group' },
        { id: 22, p1: 1, p2: 2, winner: 2, order: 2, stage: 'final' },
      ],
    };
    await syncTournament(db, fixtureClient([staged]), id);
    const stored = await db.select().from(sets);
    expect(stored.map((row) => row.resultStage).sort()).toEqual(['final', 'group']);

    await runRecompute(db);
    let recomputeId = await latestRecomputeId(db);
    let events = await db.select().from(ratingEvents).where(eq(ratingEvents.recomputeId, recomputeId!));
    expect(events.filter((event) => event.setId === stored.find((row) => row.resultStage === 'group')!.id)).toHaveLength(2);

    await db.update(tournaments).set({ resultsMode: 'final_stage_only' }).where(eq(tournaments.id, id));
    await runRecompute(db);
    recomputeId = await latestRecomputeId(db);
    events = await db.select().from(ratingEvents).where(eq(ratingEvents.recomputeId, recomputeId!));
    const groupId = stored.find((row) => row.resultStage === 'group')!.id;
    const finalId = stored.find((row) => row.resultStage === 'final')!.id;
    expect(events.filter((event) => event.setId === groupId)).toHaveLength(0);
    expect(events.filter((event) => event.setId === finalId)).toHaveLength(2);
    expect(await db.select().from(sets)).toHaveLength(2);

    await db.update(tournaments).set({ resultsMode: 'auto' }).where(eq(tournaments.id, id));
    await runRecompute(db);
    recomputeId = await latestRecomputeId(db);
    events = await db.select().from(ratingEvents).where(eq(ratingEvents.recomputeId, recomputeId!));
    expect(events.filter((event) => event.setId === groupId)).toHaveLength(2);
    expect(events.filter((event) => event.setId === finalId)).toHaveLength(2);
  });

  it('preserves a manually excluded final across policy toggles and re-sync', async () => {
    const id = await tournamentId();
    const staged: FixtureTournament = {
      ...baseFixture,
      matches: [
        { id: 31, p1: 1, p2: 2, winner: 1, order: 1, stage: 'group' },
        { id: 32, p1: 1, p2: 2, winner: 2, order: 2, stage: 'final' },
      ],
    };
    await syncTournament(db, fixtureClient([staged]), id);
    await db
      .update(sets)
      .set({ excludedFromRatings: true, exclusionManual: true })
      .where(eq(sets.challongeMatchId, 32));
    await db.update(tournaments).set({ resultsMode: 'final_stage_only' }).where(eq(tournaments.id, id));
    await syncTournament(db, fixtureClient([staged]), id);

    const [finalSet] = await db.select().from(sets).where(eq(sets.challongeMatchId, 32));
    expect(finalSet!.excludedFromRatings).toBe(true);
    expect(finalSet!.exclusionManual).toBe(true);
    await runRecompute(db);
    const recomputeId = await latestRecomputeId(db);
    const events = await db.select().from(ratingEvents).where(eq(ratingEvents.recomputeId, recomputeId!));
    expect(events.filter((event) => event.setId === finalSet!.id)).toHaveLength(0);
  });

  /**
   * A `99-0` is how the club closes a slot nobody played. It has both players
   * and a winner, so nothing upstream marks it as anything but a result — it
   * has to be recognised here, or a bye counts as a set won.
   */
  it('excludes a bye recorded as 99-0', async () => {
    const id = await tournamentId();
    const withBye: FixtureTournament = {
      ...baseFixture,
      matches: baseFixture.matches.map((m) => (m.id === 12 ? { ...m, scores: '99-0' } : m)),
    };
    await syncTournament(db, fixtureClient([withBye]), id);

    const [bye] = await db.select().from(sets).where(eq(sets.challongeMatchId, 12));
    expect(bye!.excludedFromRatings).toBe(true);
  });

  /**
   * The rule that reads a scoreline lives here, so our verdict on a set can
   * change while upstream stays byte-identical — which is exactly what happened
   * when byes joined forfeits as "not a played set". A re-sync that only
   * compares against Challonge would leave every stored `99-0` counting.
   */
  it('re-judges a stored set when the exclusion rule changes under it', async () => {
    const id = await tournamentId();
    const withBye: FixtureTournament = {
      ...baseFixture,
      matches: baseFixture.matches.map((m) => (m.id === 12 ? { ...m, scores: '99-0' } : m)),
    };
    await syncTournament(db, fixtureClient([withBye]), id);
    // Simulate the row as it was stored under the old rule.
    await db.update(sets).set({ excludedFromRatings: false }).where(eq(sets.challongeMatchId, 12));

    const result = await syncTournament(db, fixtureClient([withBye]), id);

    expect(result.setsChanged).toBe(1);
    const [bye] = await db.select().from(sets).where(eq(sets.challongeMatchId, 12));
    expect(bye!.excludedFromRatings).toBe(true);
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
    expect(tournament!.liveUntil).toBeNull();
  });

  /**
   * `sync_state` says whether WE have the results, not whether Challonge has
   * finished the bracket. It used to answer the second question, so a bracket
   * the room never closed reported "Not synced yet" on a page listing every
   * one of its synced sets. What still needs re-polling is decided from
   * `challonge_state` (see the scheduler's sweep).
   */
  it('records an unfinished bracket as synced once its results are in', async () => {
    const id = await tournamentId();
    const unfinished: FixtureTournament = { ...baseFixture, state: 'underway', completedAt: null };
    await syncTournament(db, fixtureClient([unfinished]), id);
    const [tournament] = await db.select().from(tournaments);
    expect(tournament!.syncState).toBe('synced');
    expect(tournament!.challongeState).toBe('underway');
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
