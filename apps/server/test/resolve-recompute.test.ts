import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  identityDecisions,
  playerRatings,
  players,
  ratingEvents,
  recomputes,
  reviewItems,
  sets,
  tournaments,
  type Db,
} from '@smashclub/db';
import { importRegistryPlayers, registerTournamentSlugs } from '../src/bootstrap/importRegistry';
import { syncTournament } from '../src/sync/sync';
import { resolveReviewItem } from '../src/review/resolve';
import { latestRecomputeId, runRecompute } from '../src/recompute/recompute';
import { createTestDb } from './helpers/testDb';
import { fixtureClient, type FixtureTournament } from './helpers/challongeFixtures';

let db: Db;
let close: () => Promise<void>;

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
    { id: 13, p1: 2, p2: 3, winner: 2, order: 3 },
  ],
};

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await importRegistryPlayers(db, [
    { id: 'fox-mccloud', canonical_name: 'Fox McCloud', company: 'ATL' },
    { id: 'samus-aran', canonical_name: 'Samus Aran', company: 'ATL' },
  ]);
  await registerTournamentSlugs(db, ['weekly1']);
});

afterEach(async () => {
  await close();
});

async function syncOnce(): Promise<string> {
  const [row] = await db.select({ id: tournaments.id }).from(tournaments).where(eq(tournaments.challongeSlug, 'weekly1'));
  await syncTournament(db, fixtureClient([fixture]), row!.id);
  return row!.id;
}

describe('review resolution -> recompute', () => {
  it('excludes sets with unresolved players, then includes them after resolution', async () => {
    await syncOnce();

    // Falco unresolved: only the Fox-vs-Samus set is rateable.
    const first = await runRecompute(db);
    expect(first.sets).toBe(1);
    expect(first.players).toBe(2);

    const [queueItem] = await db.select().from(reviewItems).where(eq(reviewItems.status, 'pending'));
    expect(queueItem).toBeDefined();
    const { playerId } = await resolveReviewItem(db, queueItem!.id, { kind: 'created_new' }, null);

    // Resolution backfilled the sets and the next recompute rates them all.
    const second = await runRecompute(db);
    expect(second.sets).toBe(3);
    expect(second.players).toBe(3);

    const rows = await db
      .select()
      .from(playerRatings)
      .where(eq(playerRatings.recomputeId, second.recomputeId));
    expect(rows).toHaveLength(3);
    const falcoRow = rows.find((r) => r.playerId === playerId)!;
    // Falco lost both sets: bottom rank of three.
    expect(falcoRow.rank).toBe(3);
    expect(rows.find((r) => r.rank === 1)!.wins).toBe(2); // Fox won both

    const events = await db.select().from(ratingEvents).where(eq(ratingEvents.recomputeId, second.recomputeId));
    expect(events).toHaveLength(6); // 3 sets x 2 player views, no decay in one tournament
  });

  it('records durable identity decisions on linked_existing', async () => {
    await syncOnce();
    const [queueItem] = await db.select().from(reviewItems).where(eq(reviewItems.status, 'pending'));
    const [fox] = await db.select().from(players).where(eq(players.legacyId, 'fox-mccloud'));

    await resolveReviewItem(db, queueItem!.id, { kind: 'linked_existing', playerId: fox!.id }, null);

    const decisions = await db.select().from(identityDecisions).where(eq(identityDecisions.kind, 'merge'));
    expect(decisions.some((d) => d.aliasNorm === 'falco lombardi' && d.playerId === fox!.id)).toBe(true);

    // Set 12 (Fox vs Falco) now maps both sides to the same player and is
    // dropped from rating input (self-play guard).
    const result = await runRecompute(db);
    expect(result.sets).toBe(2);
  });

  it('kept_separate records rejections so candidates are never re-suggested', async () => {
    await syncOnce();
    const [queueItem] = await db.select().from(reviewItems).where(eq(reviewItems.status, 'pending'));
    await resolveReviewItem(db, queueItem!.id, { kind: 'kept_separate' }, null);

    const [item] = await db.select().from(reviewItems).where(eq(reviewItems.id, queueItem!.id));
    expect(item!.status).toBe('resolved');
    expect(item!.resolution).toBe('kept_separate');
    // A new player was minted for the participant.
    expect(item!.resolvedPlayerId).not.toBeNull();
  });

  it('prunes old recomputes, keeping the most recent five', async () => {
    await syncOnce();
    const [queueItem] = await db.select().from(reviewItems).where(eq(reviewItems.status, 'pending'));
    await resolveReviewItem(db, queueItem!.id, { kind: 'created_new' }, null);

    for (let i = 0; i < 7; i++) {
      await runRecompute(db);
    }
    const remaining = await db.select().from(recomputes);
    expect(remaining.length).toBeLessThanOrEqual(5);
    expect(await latestRecomputeId(db)).not.toBeNull();
  });

  it('rating math in the DB matches a direct engine replay', async () => {
    await syncOnce();
    const [queueItem] = await db.select().from(reviewItems).where(eq(reviewItems.status, 'pending'));
    await resolveReviewItem(db, queueItem!.id, { kind: 'created_new' }, null);
    const { recomputeId } = await runRecompute(db);

    const { replayRatings, computeLeaderboard } = await import('@smashclub/engine');
    const { defaultGlickoSettings } = await import('@smashclub/shared');
    const setRows = await db.select().from(sets);
    const [tournament] = await db.select().from(tournaments);
    const replay = replayRatings({
      sets: setRows.map((row) => ({
        id: row.id,
        tournamentId: row.tournamentId,
        p1PlayerId: row.p1PlayerId!,
        p2PlayerId: row.p2PlayerId!,
        winner: row.winner as 1 | 2,
        suggestedPlayOrder: row.suggestedPlayOrder,
        completedAt: row.completedAt?.toISOString() ?? null,
        challongeMatchId: row.challongeMatchId,
      })),
      tournaments: [
        {
          id: tournament!.id,
          eventDate: tournament!.eventDate!.toISOString(),
          isRookie: tournament!.isRookie,
          challongeId: tournament!.challongeId,
        },
      ],
      settings: defaultGlickoSettings,
    });
    const expected = computeLeaderboard(replay.finalStates, defaultGlickoSettings);

    const stored = await db.select().from(playerRatings).where(eq(playerRatings.recomputeId, recomputeId));
    expect(stored).toHaveLength(expected.length);
    for (const row of expected) {
      const dbRow = stored.find((s) => s.playerId === row.playerId)!;
      expect(dbRow.conservativeRating).toBeCloseTo(row.conservativeRating, 9);
      expect(dbRow.rank).toBe(row.rank);
    }
  });
});
