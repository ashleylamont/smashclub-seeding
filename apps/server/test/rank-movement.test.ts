import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  playerRatings,
  players,
  ratingNights,
  recomputes,
  sets,
  tournamentParticipants,
  tournaments,
  type Db,
} from '@smashclub/db';
import { defaultRatingSettings } from '@smashclub/shared';
import { importRegistryPlayers, registerTournamentSlugs } from '../src/bootstrap/importRegistry';
import { syncTournament } from '../src/sync/sync';
import { runRecompute } from '../src/recompute/recompute';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { loadEnv } from '../src/env';
import { updateRatingSettings } from '../src/settings';
import { appRouter } from '../src/trpc/router';
import { adminCaller } from './helpers/adminCaller';
import { createTestDb } from './helpers/testDb';
import { fixtureClient, type FixtureTournament } from './helpers/challongeFixtures';

/**
 * Rank movement is movement over the club's most recent night.
 *
 * It used to be the diff between the last two recomputes, which meant it
 * reported whatever had last triggered one — a resolved identity, a settings
 * save, a model switch — and reported nothing at all once a second recompute
 * ran over the same games. This pins the property that broke: what the ▲▼
 * column says depends on the games played, not on how often the pipeline ran.
 */

let db: Db;
let close: () => Promise<void>;

const night1: FixtureTournament = {
  slug: 'night1',
  state: 'complete',
  startedAt: '2025-03-01T18:00:00.000+11:00',
  completedAt: '2025-03-01T21:00:00.000+11:00',
  participants: [
    { id: 1, name: '[ATL] Fox McCloud' },
    { id: 2, name: '[ATL] Samus Aran' },
    { id: 3, name: '[ATL] Kirby' },
  ],
  matches: [
    { id: 11, p1: 1, p2: 2, winner: 1, order: 1 },
    { id: 12, p1: 1, p2: 3, winner: 1, order: 2 },
    { id: 13, p1: 2, p2: 3, winner: 2, order: 3 },
  ],
};

/** A month later, Samus turns the head-to-head around decisively. */
const night2: FixtureTournament = {
  slug: 'night2',
  state: 'complete',
  startedAt: '2025-04-01T18:00:00.000+11:00',
  completedAt: '2025-04-01T21:00:00.000+11:00',
  participants: [
    { id: 1, name: '[ATL] Fox McCloud' },
    { id: 2, name: '[ATL] Samus Aran' },
    { id: 3, name: '[ATL] Kirby' },
  ],
  matches: [
    // `winner` is a participant id, not a side.
    { id: 21, p1: 2, p2: 1, winner: 2, order: 1 },
    { id: 22, p1: 2, p2: 3, winner: 2, order: 2 },
    { id: 23, p1: 2, p2: 1, winner: 2, order: 3 },
    { id: 24, p1: 3, p2: 1, winner: 3, order: 4 },
  ],
};

const ALL = [night1, night2];

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await importRegistryPlayers(db, [
    { id: 'fox-mccloud', canonical_name: 'Fox McCloud', company: 'ATL' },
    { id: 'samus-aran', canonical_name: 'Samus Aran', company: 'ATL' },
    { id: 'kirby', canonical_name: 'Kirby', company: 'ATL' },
  ]);
  await registerTournamentSlugs(
    db,
    ALL.map((t) => t.slug),
  );
});

afterEach(async () => {
  await close();
});

async function sync(slugs: string[]): Promise<void> {
  const client = fixtureClient(ALL);
  for (const slug of slugs) {
    const [row] = await db
      .select({ id: tournaments.id })
      .from(tournaments)
      .where(eq(tournaments.challongeSlug, slug));
    await syncTournament(db, client, row!.id);
  }
}

async function playerId(canonicalName: string): Promise<string> {
  const [row] = await db
    .select({ id: players.id })
    .from(players)
    .where(eq(players.canonicalName, canonicalName));
  return row!.id;
}

/** rank and previousRank by player name, from a recompute's stored board. */
async function board(
  recomputeId: string,
): Promise<Map<string, { rank: number; previousRank: number | null }>> {
  const rows = await db
    .select({
      canonicalName: players.canonicalName,
      rank: playerRatings.rank,
      previousRank: playerRatings.previousRank,
    })
    .from(playerRatings)
    .innerJoin(players, eq(playerRatings.playerId, players.id))
    .where(eq(playerRatings.recomputeId, recomputeId));
  return new Map(
    rows.map((row) => [row.canonicalName, { rank: row.rank, previousRank: row.previousRank }]),
  );
}

function publicApi() {
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://unused',
    BETTER_AUTH_SECRET: 'test-secret-test-secret-test',
  });
  return appRouter.createCaller({
    db,
    env,
    user: null,
    challonge: fixtureClient(ALL),
    recomputeTrigger: new RecomputeTrigger(db, 1_000_000),
  }).public;
}

/** What the board actually publishes, through the real router. */
async function publicDeltas(): Promise<Map<string, number | null>> {
  const { rows } = await publicApi().leaderboard();
  // Keyed on the canonical name, not the published one, so this map shares a
  // key space with board() above — the published name is the shortened alias,
  // and the canonical one never leaves the server on a public route, so the
  // ids are mapped back through the database rather than read off the response.
  const canonicalById = new Map(
    (await db.select({ id: players.id, canonicalName: players.canonicalName }).from(players)).map(
      (row) => [row.id, row.canonicalName],
    ),
  );
  return new Map(rows.map((row) => [canonicalById.get(row.playerId)!, row.rankDelta]));
}

async function addRatedNight(key: string, names: readonly [string, string], winners: (1 | 2)[]) {
  const [first, second] = await Promise.all(names.map(playerId));
  const slug = `movement-${key}`;
  const [night] = await db
    .insert(tournaments)
    .values({
      name: slug,
      challongeSlug: slug,
      challongeState: 'complete',
      eventDate: new Date(`${key}T08:00:00Z`),
    })
    .returning({ id: tournaments.id });
  const tournamentId = night!.id;
  const [firstEntry, secondEntry] = await db
    .insert(tournamentParticipants)
    .values(
      [first!, second!].map((id, index) => ({
        tournamentId,
        playerId: id,
        challongeParticipantId: index + 1,
        rawName: names[index]!,
        cleanedName: names[index]!,
        challongeSeed: index + 1,
      })),
    )
    .returning({ id: tournamentParticipants.id });
  await db.insert(sets).values(
    winners.map((winner, index) => ({
      tournamentId,
      challongeMatchId: index + 1,
      p1PlayerId: first!,
      p2PlayerId: second!,
      p1ParticipantId: firstEntry!.id,
      p2ParticipantId: secondEntry!.id,
      winner,
      scoresCsv: winner === 1 ? '3-0' : '0-3',
      state: 'complete',
    })),
  );
  return slug;
}

describe('rank movement over the last club night', () => {
  it('has nothing to compare against on the first night', async () => {
    await sync(['night1']);
    const run = await runRecompute(db);

    for (const [name, row] of await board(run.recomputeId)) {
      expect(row.previousRank, name).toBeNull();
    }
    for (const [name, delta] of await publicDeltas()) {
      expect(delta, name).toBeNull();
    }
  });

  it('reports exactly the standings from before the latest night', async () => {
    await sync(['night1']);
    const first = await runRecompute(db);
    const afterNight1 = await board(first.recomputeId);

    await sync(['night2']);
    const second = await runRecompute(db);
    const afterNight2 = await board(second.recomputeId);

    // Every player's `previousRank` is the rank they actually held before the
    // night — the standings the earlier recompute published.
    for (const [name, row] of afterNight2) {
      expect(row.previousRank, name).toBe(afterNight1.get(name)!.rank);
    }
    // And the night genuinely moved someone, so this is not a vacuous pass.
    expect(afterNight1.get('Fox McCloud')!.rank).toBe(1);
    expect(afterNight2.get('Samus Aran')!.rank).toBe(1);

    const deltas = await publicDeltas();
    expect(deltas.get('Samus Aran')).toBe(
      afterNight2.get('Samus Aran')!.previousRank! - afterNight2.get('Samus Aran')!.rank,
    );
    expect(deltas.get('Samus Aran')!).toBeGreaterThan(0);
    expect(deltas.get('Fox McCloud')!).toBeLessThan(0);

    const api = publicApi();
    expect(
      (await api.recap({ slug: 'night2' }))?.facts.some(({ fact }) => fact.kind === 'mover'),
    ).toBe(true);
    expect(
      (await api.recap({ slug: 'night1' }))?.facts.some(({ fact }) => fact.kind === 'mover'),
    ).toBe(false);
  });

  it('keeps movement bound to the published results while tournament dates are edited', async () => {
    await sync(['night1', 'night2']);
    const { recomputeId } = await runRecompute(db);
    const [earlier] = await db
      .select()
      .from(tournaments)
      .where(eq(tournaments.challongeSlug, 'night1'));
    const [latest] = await db
      .select()
      .from(tournaments)
      .where(eq(tournaments.challongeSlug, 'night2'));
    if (!earlier?.eventDate || !latest?.eventDate) throw new Error('Expected two dated nights');

    const api = publicApi();
    const moverIn = async (slug: string) =>
      (await api.recap({ slug }))?.facts.find(({ fact }) => fact.kind === 'mover')?.fact;
    const expectedMover = { kind: 'mover', player: { playerId: await playerId('Samus Aran') } };
    expect(await moverIn('night2')).toMatchObject(expectedMover);
    expect(await moverIn('night1')).toBeUndefined();

    const admin = adminCaller(db);
    const queued = vi.spyOn(RecomputeTrigger.prototype, 'request').mockImplementation(() => {});
    try {
      const latestDate = latest.eventDate.toISOString();
      await admin.updateTournament({ tournamentId: earlier.id, eventDate: latestDate });
      const mixed = await api.recap({ slug: 'night1' });
      expect(mixed?.tournaments.map(({ slug }) => slug).sort()).toEqual(['night1', 'night2']);
      expect.soft(mixed?.facts.find(({ fact }) => fact.kind === 'mover')).toBeUndefined();

      await admin.updateTournament({ tournamentId: latest.id, eventDate: null });
      const moved = await api.recap({ slug: 'night1' });
      expect(moved?.tournaments.map(({ slug }) => slug)).toEqual(['night1']);
      expect.soft(moved?.facts.find(({ fact }) => fact.kind === 'mover')).toBeUndefined();

      await admin.updateTournament({
        tournamentId: earlier.id,
        eventDate: earlier.eventDate.toISOString(),
      });
      await admin.updateTournament({ tournamentId: latest.id, eventDate: latestDate });
      expect(await moverIn('night2')).toMatchObject(expectedMover);
      expect(queued).toHaveBeenCalledTimes(4);
      expect(await db.select({ id: recomputes.id }).from(recomputes)).toEqual([
        { id: recomputeId },
      ]);

      await db.delete(ratingNights).where(eq(ratingNights.recomputeId, recomputeId));
      expect(await moverIn('night2')).toBeUndefined();
    } finally {
      queued.mockRestore();
    }
  });

  it('requires a complete rated night before a recap can report rank movement', async () => {
    await sync(['night1', 'night2']);
    const sideBracket: FixtureTournament = {
      ...night2,
      slug: 'night2-side',
      matches: [
        { id: 50, p1: 3, p2: 1, winner: 3, order: 1 },
        { id: 51, p1: 3, p2: 2, winner: 3, order: 2, scores: '99-0' },
      ],
    };
    await registerTournamentSlugs(db, [sideBracket.slug]);
    const [side] = await db
      .select()
      .from(tournaments)
      .where(eq(tournaments.challongeSlug, sideBracket.slug));
    await syncTournament(db, fixtureClient([sideBracket]), side!.id);
    const { recomputeId } = await runRecompute(db);
    const [primary] = await db
      .select()
      .from(tournaments)
      .where(eq(tournaments.challongeSlug, 'night2'));
    const [run] = await db
      .select({ stats: recomputes.stats })
      .from(recomputes)
      .where(eq(recomputes.id, recomputeId));
    if (!primary?.eventDate || !run?.stats) throw new Error('Expected a published, dated night');
    expect(run.stats).toMatchObject({ whrLatestRatedSetCount: 5 });

    const api = publicApi();
    const samus = await playerId('Samus Aran');
    const expectedMover = { kind: 'mover', player: { playerId: samus }, rank: 1, previousRank: 2 };
    const getRecap = () => api.recap({ slug: sideBracket.slug });
    const movers = (recap: Awaited<ReturnType<typeof getRecap>>) =>
      recap?.facts.flatMap(({ fact }) => (fact.kind === 'mover' ? [fact] : []));
    const expectFullRecap = async () => {
      const full = await getRecap();
      expect(full?.tournaments.map(({ slug }) => slug).sort()).toEqual(['night2', 'night2-side']);
      expect(movers(full)?.find(({ player }) => player.playerId === samus)).toMatchObject(
        expectedMover,
      );
    };
    const admin = adminCaller(db);
    const queued = vi.spyOn(RecomputeTrigger.prototype, 'request').mockImplementation(() => {});
    try {
      for (const legacy of [false, true]) {
        if (legacy) {
          const { whrLatestRatedSetCount: _count, ...legacyStats } = run.stats as Record<
            string,
            unknown
          >;
          await db
            .update(recomputes)
            .set({ stats: legacyStats })
            .where(eq(recomputes.id, recomputeId));
        }
        await expectFullRecap();

        await admin.updateTournament({ tournamentId: primary.id, eventDate: null });
        const partial = await getRecap();
        expect(partial?.tournaments.map(({ slug }) => slug)).toEqual(['night2-side']);
        expect(partial?.setsPlayed).toBe(1);
        expect
          .soft(movers(partial), legacy ? 'legacy published run' : 'current published run')
          .toEqual([]);
        expect(
          (await api.leaderboard()).rows.find(({ playerId }) => playerId === samus),
        ).toMatchObject({
          rank: 1,
          previousRank: 2,
          rankDelta: 1,
        });

        await admin.updateTournament({
          tournamentId: primary.id,
          eventDate: primary.eventDate.toISOString(),
        });
        await expectFullRecap();
      }
      expect(queued).toHaveBeenCalledTimes(4);
      expect(await db.select({ id: recomputes.id }).from(recomputes)).toEqual([
        { id: recomputeId },
      ]);

      // Removing a fixture set cascades into the older run's ledger. Its
      // remaining rows can no longer prove complete coverage.
      await db.delete(sets).where(eq(sets.tournamentId, primary.id));
      expect.soft(movers(await getRecap())).toEqual([]);
    } finally {
      queued.mockRestore();
    }
  });

  it('keeps converged ranks while withholding movement from a capped previous fit', async () => {
    await updateRatingSettings(db, {
      ...defaultRatingSettings,
      activityGraceEvents: 0,
      activityPenaltyPerEvent: 15,
      activityPenaltyCap: 75,
    });
    const pair = ['Fox McCloud', 'Samus Aran'] as const;
    await addRatedNight('2026-01-01', pair, [...Array<1>(38).fill(1), ...Array<2>(30).fill(2)]);
    const slug = await addRatedNight('2026-01-08', pair, Array<2>(9).fill(2));
    const { recomputeId } = await runRecompute(db);
    const [run] = await db
      .select({ stats: recomputes.stats })
      .from(recomputes)
      .where(eq(recomputes.id, recomputeId));
    expect(run?.stats).toMatchObject({
      whr: { converged: true },
      whrConvergedPreNightKeys: [],
    });
    expect.soft(await board(recomputeId)).toEqual(
      new Map([
        ['Samus Aran', { rank: 1, previousRank: null }],
        ['Fox McCloud', { rank: 2, previousRank: null }],
      ]),
    );

    // An older build stored the capped prefix's ranks. Public readers must
    // suppress these existing rows without changing the published current run.
    const samus = await playerId('Samus Aran');
    await db
      .update(playerRatings)
      .set({ previousRank: 2 })
      .where(and(eq(playerRatings.recomputeId, recomputeId), eq(playerRatings.playerId, samus)));
    const api = publicApi();
    const { rows } = await api.leaderboard();
    expect.soft(rows).toMatchObject([
      { playerId: samus, rank: 1, previousRank: null, rankDelta: null },
      { rank: 2, previousRank: null, rankDelta: null },
    ]);
    expect.soft(rows.every(({ activityPenalty }) => activityPenalty === 0)).toBe(true);
    const recap = await api.recap({ slug });
    expect.soft(recap?.facts.some(({ fact }) => fact.kind === 'mover')).toBe(false);

    // When that run has no convergence provenance, stored ranks still do not
    // prove that the comparison is reliable.
    await db
      .update(recomputes)
      .set({ stats: { whr: { converged: true } } })
      .where(eq(recomputes.id, recomputeId));
    expect.soft((await api.leaderboard()).rows[0]).toMatchObject({
      rank: 1,
      previousRank: null,
      rankDelta: null,
    });

    await db.insert(players).values({ canonicalName: 'Delta' });
    await addRatedNight('2026-01-15', ['Kirby', 'Delta'], [1]);
    await runRecompute(db);
    const next = (await api.leaderboard()).rows.find(({ playerId }) => playerId === samus);
    expect(next).toMatchObject({
      rank: 2,
      previousRank: 1,
      rankDelta: -1,
      missedEvents: 1,
      activityPenalty: 15,
    });
  });

  it('does not forget the movement when the pipeline runs again', async () => {
    await sync(['night1', 'night2']);
    await runRecompute(db);
    const before = await publicDeltas();

    // A second recompute over the same games — what any resolved identity or
    // settings save triggers. Under the old recompute-diff this flattened every
    // arrow to "–" because the two most recent boards were identical.
    const again = await runRecompute(db);
    expect(await publicDeltas()).toEqual(before);

    const rows = await board(again.recomputeId);
    expect(rows.get('Samus Aran')!.previousRank).not.toBeNull();
    expect([...before.values()].some((delta) => (delta ?? 0) !== 0)).toBe(true);
  });

  it('withholds the whole event, not just one bracket of it', async () => {
    // A rookie bracket on the same evening as the main one: a player who only
    // entered the rookie side must still be compared against the standings from
    // before that evening, not against a board that already has the main
    // bracket's results in it.
    const sameNightRookie: FixtureTournament = {
      slug: 'night2-rookie',
      state: 'complete',
      startedAt: '2025-04-01T20:30:00.000+11:00',
      completedAt: '2025-04-01T22:30:00.000+11:00',
      participants: [
        { id: 1, name: '[ATL] Kirby' },
        { id: 2, name: '[ATL] Samus Aran' },
      ],
      matches: [{ id: 31, p1: 1, p2: 2, winner: 1, order: 1 }],
    };
    await registerTournamentSlugs(db, ['night2-rookie']);
    const client = fixtureClient([...ALL, sameNightRookie]);
    for (const slug of ['night1', 'night2', 'night2-rookie']) {
      const [row] = await db
        .select({ id: tournaments.id })
        .from(tournaments)
        .where(eq(tournaments.challongeSlug, slug));
      await syncTournament(db, client, row!.id);
    }

    const withRookie = await runRecompute(db);
    const rows = await board(withRookie.recomputeId);

    // Withholding only the main bracket would leave the rookie set in the
    // "before" board, so Kirby's win over Samus would already be counted on
    // both sides and show as no movement at all.
    const [kirbyBefore] = await db
      .select({ previousRank: playerRatings.previousRank })
      .from(playerRatings)
      .where(
        and(
          eq(playerRatings.recomputeId, withRookie.recomputeId),
          eq(playerRatings.playerId, await playerId('Kirby')),
        ),
      );
    expect(kirbyBefore!.previousRank).toBe(rows.get('Kirby')!.previousRank);
    expect(rows.get('Kirby')!.previousRank).toBe(3); // bottom of the night-one board
  });
});
