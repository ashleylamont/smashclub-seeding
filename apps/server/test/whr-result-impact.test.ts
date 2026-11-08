import { eq } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { players, recomputes, sets, tournaments, type Db } from '@smashclub/db';
import { DISPLAY_CENTRE, NATURAL_TO_DISPLAY, fitWhr } from '@smashclub/engine';
import { defaultRatingSettings } from '@smashclub/shared';
import { loadEnv } from '../src/env';
import { latestRecomputeId, needsRatingRecompute, runRecompute } from '../src/recompute/recompute';
import { loadSinglesHistory } from '../src/recompute/inputs';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { updateRatingSettings } from '../src/settings';
import { appRouter } from '../src/trpc/router';
import { fixtureClient } from './helpers/challongeFixtures';
import { createTestDb } from './helpers/testDb';

function publicCaller(db: Db) {
  return appRouter.createCaller({
    db,
    env: loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://unused',
      BETTER_AUTH_SECRET: 'test-secret-test-secret-test',
    }),
    user: null,
    challonge: fixtureClient([]),
    recomputeTrigger: new RecomputeTrigger(db, 1_000_000),
  }).public;
}

it('reads independent effects from the published night and rejects a cached effect after a canonical correction', async () => {
  const { db, close } = await createTestDb();
  try {
    const api = publicCaller(db);
    const [regular, returner, newcomer, outsider] = await db
      .insert(players)
      .values(
        ['Regular', 'Returning', 'Debut', 'Spectator'].map((canonicalName) => ({ canonicalName })),
      )
      .returning();
    const [early, focus, later] = await db
      .insert(tournaments)
      .values([
        {
          challongeSlug: 'early',
          name: 'Previous night',
          eventDate: new Date('2025-01-01T08:00:00Z'),
        },
        {
          challongeSlug: 'focus',
          name: 'Rookie night',
          eventDate: new Date('2026-01-01T08:00:00Z'),
          isRookie: true,
        },
        {
          challongeSlug: 'later',
          name: 'Later night',
          eventDate: new Date('2026-01-15T08:00:00Z'),
        },
      ])
      .returning();
    const [prior, focusWin, focusLoss, bye, forfeit] = await db
      .insert(sets)
      .values([
        {
          tournamentId: early!.id,
          challongeMatchId: 1,
          state: 'complete',
          p1PlayerId: regular!.id,
          p2PlayerId: returner!.id,
          winner: 1,
          scoresCsv: '3-0',
        },
        {
          tournamentId: focus!.id,
          challongeMatchId: 2,
          state: 'complete',
          p1PlayerId: newcomer!.id,
          p2PlayerId: returner!.id,
          winner: 1,
          scoresCsv: '3-0',
        },
        {
          tournamentId: focus!.id,
          challongeMatchId: 3,
          state: 'complete',
          p1PlayerId: newcomer!.id,
          p2PlayerId: regular!.id,
          winner: 2,
          scoresCsv: '2-3',
        },
        {
          tournamentId: focus!.id,
          challongeMatchId: 4,
          state: 'complete',
          p1PlayerId: newcomer!.id,
          p2PlayerId: returner!.id,
          winner: 1,
          scoresCsv: '99-0',
        },
        {
          tournamentId: focus!.id,
          challongeMatchId: 5,
          state: 'complete',
          p1PlayerId: newcomer!.id,
          p2PlayerId: regular!.id,
          winner: 1,
          scoresCsv: '3-0',
          raw: { outcome: 'forfeit' },
        },
      ])
      .returning();
    const bounds = {
      before: new Date('2026-01-02T00:00:00Z'),
      maxTournaments: 10,
      maxSets: 10,
      maxNativeRows: 10,
    };
    expect(await loadSinglesHistory(db, { ...bounds, maxSets: 2 })).toBeNull();
    expect(await loadSinglesHistory(db, { ...bounds, maxTournaments: 1 })).toBeNull();
    const bounded = await loadSinglesHistory(db, bounds);
    expect(bounded?.engineSets.map((set) => set.id)).toEqual(
      expect.arrayContaining([prior!.id, focusWin!.id, focusLoss!.id]),
    );
    expect(bounded?.engineSets).toHaveLength(3);

    const settings = { ...defaultRatingSettings, whrRookieDebutPrior: 1400 };
    await updateRatingSettings(db, settings);
    const initial = await runRecompute(db);
    const input = { playerId: newcomer!.id, setId: focusWin!.id, recomputeId: initial.recomputeId };
    const first = await api.whrResultImpact(input);
    expect(first).toMatchObject({
      status: 'available',
      firstNight: true,
      evidenceWeight: 2,
      forecast: null,
    });
    const secondSide = await api.whrResultImpact({ ...input, playerId: returner!.id });
    expect(secondSide).toMatchObject({ status: 'available', firstNight: false });
    expect(secondSide.status === 'available' && secondSide.effectPoints).toBeLessThan(0);

    const full = [
      { p1PlayerId: regular!.id, p2PlayerId: returner!.id, winner: 1 as const, time: 0, trials: 2 },
      {
        p1PlayerId: newcomer!.id,
        p2PlayerId: returner!.id,
        winner: 1 as const,
        time: 365,
        trials: 2,
      },
      {
        p1PlayerId: newcomer!.id,
        p2PlayerId: regular!.id,
        winner: 2 as const,
        time: 365,
        trials: 1,
      },
    ];
    const priors = new Map([[newcomer!.id, (1400 - DISPLAY_CENTRE) / NATURAL_TO_DISPLAY]]);
    const rating = (included: typeof full) =>
      fitWhr({ sets: included, priorMeans: priors }).display(newcomer!.id, 365).rating;
    const nightlyMovement = rating(full) - 1400;
    const independentWin = rating(full) - rating([full[0]!, full[2]!]);
    expect(first.status === 'available' && first.effectPoints).toBeCloseTo(independentWin, 6);
    const second = await api.whrResultImpact({ ...input, setId: focusLoss!.id });
    expect(second.status === 'available' && second.effectPoints).toBeCloseTo(
      rating(full) - rating(full.slice(0, 2)),
      6,
    );
    expect(
      Math.abs(
        independentWin +
          (second.status === 'available' ? second.effectPoints : 0) -
          nightlyMovement,
      ),
    ).toBeGreaterThan(1);

    for (const setId of [bye!.id, forfeit!.id])
      expect(await api.whrResultImpact({ ...input, setId })).toEqual({
        status: 'unavailable',
        reason: 'not_rated',
      });
    expect(await api.whrResultImpact({ ...input, playerId: outsider!.id })).toEqual({
      status: 'unavailable',
      reason: 'not_rated',
    });

    const [laterSet] = await db
      .insert(sets)
      .values({
        tournamentId: later!.id,
        challongeMatchId: 6,
        state: 'complete',
        p1PlayerId: newcomer!.id,
        p2PlayerId: regular!.id,
        winner: 1,
        scoresCsv: '3-2',
      })
      .returning();
    expect(await api.whrResultImpact(input)).toEqual(first);
    const extended = await runRecompute(db);
    expect(await api.whrResultImpact(input)).toEqual({
      status: 'unavailable',
      reason: 'stale_run',
    });
    const updated = { ...input, recomputeId: extended.recomputeId };
    expect(await api.whrResultImpact(updated)).toEqual(first);
    const laterImpact = await api.whrResultImpact({ ...updated, setId: laterSet!.id });
    expect(laterImpact).toMatchObject({
      status: 'available',
      firstNight: false,
      forecast: { winProbability: expect.any(Number), opponentSkill: expect.any(Number) },
    });

    await db.update(sets).set({ winner: 2, scoresCsv: '0-3' }).where(eq(sets.id, prior!.id));
    expect(await api.whrResultImpact(updated)).toEqual({
      status: 'unavailable',
      reason: 'history_changed',
    });
    expect(await needsRatingRecompute(db)).toBe(false);
    await db
      .update(recomputes)
      .set({ stats: { ratingNights: 3 } })
      .where(eq(recomputes.id, extended.recomputeId));
    expect(await needsRatingRecompute(db)).toBe(true);
    expect(await latestRecomputeId(db)).toBe(extended.recomputeId);
    expect(await api.whrResultImpact(updated)).toEqual({
      status: 'unavailable',
      reason: 'older_run',
    });
  } finally {
    await close();
  }
});

it('uses the assigned debut prior when the omitted result is the player’s only result', async () => {
  const { db, close } = await createTestDb();
  try {
    const [first, second] = await db
      .insert(players)
      .values([{ canonicalName: 'First debut' }, { canonicalName: 'Second debut' }])
      .returning();
    const [night] = await db
      .insert(tournaments)
      .values({
        challongeSlug: 'single-rookie',
        name: 'Rookie night',
        eventDate: new Date('2026-01-01T08:00:00Z'),
        isRookie: true,
      })
      .returning();
    const [played] = await db
      .insert(sets)
      .values({
        tournamentId: night!.id,
        challongeMatchId: 1,
        state: 'complete',
        p1PlayerId: first!.id,
        p2PlayerId: second!.id,
        winner: 1,
        scoresCsv: '3-0',
      })
      .returning();
    await updateRatingSettings(db, { ...defaultRatingSettings, whrRookieDebutPrior: 1400 });
    const { recomputeId } = await runRecompute(db);
    const api = publicCaller(db);
    // Move to a new request window without changing the published run's timestamp.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 10_000));
    const impact = await api.whrResultImpact({
      recomputeId,
      setId: played!.id,
      playerId: first!.id,
    });
    const profile = await api.player({ playerId: first!.id });
    expect(profile && 'recomputeId' in profile && profile.recomputeId).toBe(recomputeId);
    expect(impact).toMatchObject({ status: 'available', firstNight: true, forecast: null });
    if (!profile || !('nights' in profile) || !profile.nights)
      throw new Error('Expected the published player profile and rating nights.');
    expect(impact.status === 'available' && impact.effectPoints).toBeCloseTo(
      profile.nights[0]!.postRating - 1400,
      6,
    );
  } finally {
    vi.useRealTimers();
    await close();
  }
});

it('does not keep scheduling startup backfill for a current empty rating history', async () => {
  const { db, close } = await createTestDb();
  try {
    expect(await needsRatingRecompute(db)).toBe(true);
    const run = await runRecompute(db);
    expect(await needsRatingRecompute(db)).toBe(false);
    await db
      .update(recomputes)
      .set({
        stats: {
          ratingNights: 0,
          whrPrefixFingerprintVersion: 0,
          whrPrefixFingerprints: {},
        },
      })
      .where(eq(recomputes.id, run.recomputeId));
    expect(await needsRatingRecompute(db)).toBe(true);
    expect(await latestRecomputeId(db)).toBe(run.recomputeId);
  } finally {
    await close();
  }
});
