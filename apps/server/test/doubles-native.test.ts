import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryStore } from '@rotorsoft/act';
import { eq } from 'drizzle-orm';
import {
  eventPlanEntries,
  eventPlans,
  eventOperationSettings,
  playerRatings,
  players,
  sets,
  tournamentParticipants,
  tournaments,
  user,
  type Db,
} from '@smashclub/db';
import { createTestDb } from './helpers/testDb';
import { nativeAdmin, pureBaseline, envelope } from './helpers/nativeLiveFixture';
import { createNativeRuntime, type NativeRuntime } from '../src/tournament/runtime';
import { appRouter } from '../src/trpc/router';
import { loadEnv } from '../src/env';
import { ChallongeClient } from '../src/challonge/client';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { captureBaseline, decide, hash, reduceDecision, stableId } from '../src/tournament/domain';
import { processNativeRatingIntents, publishNativeResult } from '../src/tournament/publication';
import { loadDoublesRatings } from '../src/recompute/doubles';
import { runRecompute } from '../src/recompute/recompute';
import { Baseline } from '../src/tournament/schemas';

describe('native doubles through shipped APIs', () => {
  let db: Db, close: () => Promise<void>, runtime: NativeRuntime;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    await db.insert(user).values(nativeAdmin);
    runtime = createNativeRuntime(db, new InMemoryStore());
  });
  afterAll(async () => {
    await runtime.shutdown();
    await close();
  });
  const caller = () =>
    appRouter.createCaller({
      db,
      user: nativeAdmin,
      nativeRuntime: runtime,
      env: loadEnv({ DATABASE_URL: 'pglite://memory', NODE_ENV: 'test' }),
      challonge: new ChallongeClient({}),
      recomputeTrigger: new RecomputeTrigger(db),
    });
  async function draft(
    count: number,
    structure: 'round_robin' | 'pools_finals' | 'dual_division',
    date = '2026-10-01T00:00:00Z',
  ) {
    const members = await db
      .insert(players)
      .values(
        Array.from({ length: count * 2 }, (_, i) => ({
          canonicalName: `Private Surname ${crypto.randomUUID()}`,
          displayName: `Alias ${crypto.randomUUID()} ${i}`,
        })),
      )
      .returning();
    const { planId } = await caller().admin.eventPlanner.createPlan({
      competitionFormat: 'doubles',
      bracketMode: 'native',
      structure,
      name: `Doubles ${structure}`,
      eventDate: date,
      rows: [],
    });
    for (let i = 0; i < count; i++)
      await caller().admin.eventPlanner.addDoublesPair({
        planId,
        playerId: members[i * 2]!.id,
        partnerPlayerId: members[i * 2 + 1]!.id,
        teamName: `Pair ${i}`,
      });
    return { planId, members };
  }
  async function prepare(planId: string) {
    await caller().admin.eventPlanner.freezeRoster({ planId });
    await caller().admin.eventPlanner.generatePools({ planId });
    await db.insert(eventOperationSettings).values({
      eventPlanId: planId,
      published: true,
      playerReports: true,
      scoreReportingMode: 'approve_unless_disputed',
    });
    await caller().eventOps.softLockPools({ planId, confirm: true });
    await caller().eventOps.prepare({ planId });
  }
  async function scoreReady(planId: string) {
    while (true) {
      const state = await runtime.state(planId),
        ready = state.matches.filter((m) => m.status === 'ready' || m.status === 'playing');
      if (!ready.length) break;
      for (const m of ready)
        await caller().eventOps.reportScore({
          matchId: m.id,
          expectedRevision: m.revision,
          requestId: crypto.randomUUID(),
          score1: 2,
          score2: 0,
          outcome: 'played',
        });
    }
  }
  async function finishPools(planId: string) {
    await scoreReady(planId);
    const view = (await caller().admin.eventPlanner.plan({ planId }))!;
    for (const d of view.divisions)
      await caller().admin.eventPlanner.savePoolPlacements({
        planId,
        division: d.division,
        pools: d.pools.map((p) => ({
          poolIndex: p.poolIndex,
          playerIdsInOrder: p.members.map((m) => m.playerId),
          expectedMatchRevisions: p.matchRevisions!,
          expectedPlacementRevision: p.placementRevision!,
        })),
      });
  }
  for (const [structure, count, brackets] of [
    ['round_robin', 4, 1],
    ['pools_finals', 8, 2],
    ['dual_division', 12, 4],
  ] as const)
    it(`runs ${count} pairs in ${structure}, publishes one fact per set, and preserves singles ratings`, async () => {
      const { planId, members } = await draft(count, structure);
      await prepare(planId);
      const state = await runtime.state(planId);
      expect(state.baseline!.version).toBe(2);
      expect(state.entrants.flatMap((e) => e.memberPlayerIds!)).toHaveLength(count * 2);
      expect(
        state.entrants.every((e) => e.playerId === e.id && e.memberPlayerIds!.length === 2),
      ).toBe(true);
      expect(await runtime.replay(planId)).toEqual(state);
      const publicView = await caller().eventOps.snapshot({ planId });
      expect(publicView.matches[0]!.player1Name).toContain('Alias');
      expect(JSON.stringify(publicView)).not.toContain('Private Surname');
      const roster = await caller().eventOps.attendeeRoster({ planId });
      expect(roster.attendees).toHaveLength(count * 2);
      await expect(
        caller().admin.eventPlanner.updateEntry({
          planId,
          entryId: state.entrants[0]!.id,
          partnerPlayerId: members[3]!.id,
        }),
      ).rejects.toThrow(/draft|frozen|owned/);
      await finishPools(planId);
      const preview = await caller().eventOps.native.preview({ planId });
      expect(preview.allowed).toBe(true);
      if (structure !== 'round_robin') {
        await caller().eventOps.native.generate({ planId, revisionToken: preview.revisionToken });
        await scoreReady(planId);
      }
      await caller().eventOps.native.finalize({ planId });
      const complete = await runtime.state(planId);
      expect(complete.lifecycle).toBe('finalized');
      expect(complete.brackets).toHaveLength(brackets);
      expect(complete.publication?.tournamentIds).toHaveLength(brackets);
      const publishedIds = new Set(complete.publication!.tournamentIds);
      const historical = (await db.select().from(sets)).filter((s) =>
        publishedIds.has(s.tournamentId),
      );
      expect(historical).toHaveLength(complete.matches.length);
      expect(historical.every((s) => s.p1PlayerId === null && s.p2PlayerId === null)).toBe(true);
      const participants = (await db.select().from(tournamentParticipants)).filter((p) =>
        publishedIds.has(p.tournamentId),
      );
      expect(
        participants.every((p) => p.playerId === null && p.memberPlayerIds?.length === 2),
      ).toBe(true);
      await publishNativeResult(db, complete.result!);
      expect(
        (await db.select().from(sets)).filter((s) => publishedIds.has(s.tournamentId)),
      ).toHaveLength(historical.length);
      const [tournament] = await db
        .select()
        .from(tournaments)
        .where(eq(tournaments.id, complete.publication!.tournamentIds[0]!));
      const event = await caller().public.eventOverview({ slug: tournament!.challongeSlug });
      expect(event!.warnings).toEqual([]);
      expect(event!.divisions.every((d) => d.notice === null)).toBe(true);
      expect(event!.divisions.flatMap((d) => d.players)).toHaveLength(count);
      expect(event!.divisions.flatMap((d) => d.players).every((p) => p.place !== null)).toBe(true);
      expect(JSON.stringify(event)).not.toContain('Private Surname');
      const detail = await caller().public.tournament({ slug: tournament!.challongeSlug });
      expect(detail!.participants[0]!.name).toContain(' / ');
      expect(detail!.participants[0]!.name).toMatch(/^Pair \d+ \(/);
      expect(JSON.stringify(detail)).not.toContain('Private Surname');
      await processNativeRatingIntents(db);
      const recompute = await runRecompute(db);
      expect(recompute.sets).toBe(0);
      expect(await db.select().from(playerRatings)).toHaveLength(0);
      const fit = await loadDoublesRatings(db, Date.parse('2026-10-10T00:00:00Z'));
      expect(fit.converged).toBe(true);
      expect(
        Number.isFinite(
          fit.rating([members[0]!.id, members[1]!.id], Date.parse('2026-10-10') / 86400000).rating,
        ),
      ).toBe(true);
    });
  it('rejects duplicate members, incomplete pairs, and external doubles', async () => {
    const { planId, members } = await draft(1, 'round_robin');
    await expect(
      caller().admin.eventPlanner.addDoublesPair({
        planId,
        playerId: members[0]!.id,
        partnerPlayerId: members[1]!.id,
      }),
    ).rejects.toThrow(/once/);
    const [other] = await db.insert(players).values({ canonicalName: 'Other' }).returning();
    const [entry] = await db
      .select()
      .from(eventPlanEntries)
      .where(eq(eventPlanEntries.eventPlanId, planId));
    await expect(
      caller().admin.eventPlanner.updateEntry({
        planId,
        entryId: entry!.id,
        partnerPlayerId: members[0]!.id,
      }),
    ).rejects.toThrow(/once/);
    await caller().admin.eventPlanner.updateEntry({
      planId,
      entryId: entry!.id,
      partnerPlayerId: null,
    });
    await expect(caller().admin.eventPlanner.freezeRoster({ planId })).rejects.toThrow(
      /two entrants|Resolve/,
    );
    await expect(
      caller().admin.eventPlanner.createPlan({
        competitionFormat: 'doubles',
        bracketMode: 'challonge',
        name: 'Invalid',
        eventDate: '2026-10-01T00:00:00Z',
        rows: [],
      }),
    ).rejects.toThrow(/Nemesis/);
    expect(other).toBeDefined();
  });
  it('keeps new pairs at zero before their first event and excludes same-night evidence', async () => {
    const fit = await loadDoublesRatings(db, Date.parse('2026-10-01T12:00:00Z'));
    expect(fit.pairs).toEqual([]);
  });
  it('holds both members’ matches consistently in the public queue and rejects live pair additions', async () => {
    const { planId } = await draft(4, 'round_robin');
    await prepare(planId);
    await caller().eventOps.saveStation({ planId, name: 'Four-controller station' });
    const state = await runtime.state(planId),
      entrant = state.entrants[0]!,
      member = entrant.memberPlayerIds![1]!;
    await caller().eventOps.live.command({
      planId,
      requestId: 'member-away',
      command: {
        kind: 'availability',
        playerId: member,
        availability: 'snoozed',
        expectedRevision: entrant.revision,
        reason: 'Taking a break',
      },
    });
    const snapshot = await caller().eventOps.snapshot({ planId });
    const involved = snapshot.matches.filter((m) =>
      [m.player1Id, m.player2Id].includes(entrant.playerId),
    );
    expect(involved.every((m) => !m.availability.canStart)).toBe(true);
    expect(snapshot.stationQueues.every((q) => !involved.some((m) => m.id === q.nextMatchId))).toBe(
      true,
    );
    const preview = await caller().eventOps.previewAttendance({
      planId,
      action: 'add',
      playerId: crypto.randomUUID(),
      division: 'upper',
    });
    expect(preview.allowed).toBe(false);
    expect(preview.issues.join(' ')).toMatch(/fixed/);
  });
  it('runs a configurable nine-team double round robin and retains its variant through correction and replay', async () => {
    const { planId } = await draft(9, 'round_robin');
    await caller().admin.eventPlanner.updateNativeFormat({
      planId,
      structure: 'round_robin',
      structureOptions: { roundRobinMeetings: 2 },
    });
    expect((await caller().admin.eventPlanner.plan({ planId }))!.plan.structureOptions).toEqual({
      roundRobinMeetings: 2,
    });
    await prepare(planId);
    const locked = await runtime.state(planId);
    expect(locked.baseline!.structureOptions).toEqual({ roundRobinMeetings: 2 });
    expect(locked.matches).toHaveLength(72);
    const snapshot = await caller().eventOps.snapshot({ planId });
    expect(snapshot.poolRounds[0]!.rounds).toHaveLength(18);
    for (const round of snapshot.poolRounds[0]!.rounds) {
      const playing = locked.matches
        .filter((m) => round.matchIds.includes(m.id))
        .flatMap((m) => [m.player1Id, m.player2Id]);
      expect(new Set(playing).size).toBe(playing.length);
    }
    await expect(
      caller().admin.eventPlanner.updateNativeFormat({
        planId,
        structure: 'round_robin',
        structureOptions: { roundRobinMeetings: 1 },
      }),
    ).rejects.toThrow(/draft|owned/);
    await finishPools(planId);
    await caller().eventOps.native.finalize({ planId });
    const state = await runtime.state(planId);
    expect(state.result!.structureOptions).toEqual({ roundRobinMeetings: 2 });
    expect(state.result!.matches).toHaveLength(72);
    const match = state.matches[0]!;
    await caller().eventOps.live.command({
      planId,
      requestId: 'nine-team-correction',
      command: {
        kind: 'replaceResult',
        resultId: state.result!.id,
        reason: 'Reviewed nine-team standings',
        corrections: [
          {
            matchId: match.id,
            expectedRevision: match.revision,
            score1: 0,
            score2: 2,
            outcome: 'played',
          },
        ],
        roundRobinOrder: [...state.pools[0]!.order!].reverse(),
      },
    });
    const corrected = await runtime.state(planId);
    expect(corrected.result!.revision).toBe(2);
    expect(corrected.result!.structureOptions).toEqual({ roundRobinMeetings: 2 });
    expect(corrected.result!.matches).toHaveLength(72);
    expect(await runtime.replay(planId)).toEqual(corrected);
  });

  it('publishes reviewed round-robin corrections without double-counting earlier pair evidence', async () => {
    const { planId, members } = await draft(4, 'round_robin');
    await prepare(planId);
    await finishPools(planId);
    await caller().eventOps.native.finalize({ planId });
    const state = await runtime.state(planId),
      match = state.matches[0]!,
      resultId = state.result!.id;
    const before = await loadDoublesRatings(db, Date.parse('2026-10-10'));
    const at = Date.parse('2026-10-10') / 86400000,
      pair = [members[0]!.id, members[1]!.id] as const;
    const correction = {
      kind: 'replaceResult' as const,
      resultId,
      reason: 'Reviewed score and tiebreaks',
      corrections: [
        {
          matchId: match.id,
          expectedRevision: match.revision,
          score1: 0,
          score2: 2,
          outcome: 'played' as const,
        },
      ],
    };
    await expect(
      caller().eventOps.live.command({ planId, requestId: 'missing-order', command: correction }),
    ).rejects.toThrow(/finishing order/);
    await caller().eventOps.live.command({
      planId,
      requestId: 'reviewed-order',
      command: { ...correction, roundRobinOrder: [...state.pools[0]!.order!].reverse() },
    });
    const corrected = await runtime.state(planId);
    expect(corrected.result!.revision).toBe(2);
    expect(corrected.result!.matches).toHaveLength(state.matches.length);
    const after = await loadDoublesRatings(db, Date.parse('2026-10-10'));
    expect(after.evidence(pair)).toEqual(before.evidence(pair));
    expect(after.rating(pair, at).rating).toBeLessThan(before.rating(pair, at).rating);
    expect(after.provenance.sourceResultIds).not.toContain(resultId);
    expect(after.provenance.sourceResultIds).toContain(corrected.result!.id);
    const [t] = await db
      .select()
      .from(tournaments)
      .where(eq(tournaments.id, corrected.publication!.tournamentIds[0]!));
    const overview = await caller().public.eventOverview({ slug: t!.challongeSlug });
    expect(overview!.divisions[0]!.players.find((p) => p.place === 1)?.entryKey).toBe(
      `pair:${JSON.stringify([members[6]!.id, members[7]!.id].sort())}`,
    );
    const profile = await caller().public.player({ playerId: members[7]!.id });
    expect(profile && 'doublesResults' in profile ? profile.doublesResults : []).toHaveLength(1);
  });
  it('retains pair evidence across a historical identity redirect without giving it to a new partner', async () => {
    const { planId, members } = await draft(2, 'round_robin', '2026-10-02T00:00:00Z');
    await prepare(planId);
    await finishPools(planId);
    await caller().eventOps.native.finalize({ planId });
    const [survivor] = await db
      .insert(players)
      .values({ canonicalName: `Surviving identity ${crypto.randomUUID()}` })
      .returning();
    await caller().admin.mergePlayers({ fromPlayerId: members[0]!.id, intoPlayerId: survivor!.id });
    const fit = await loadDoublesRatings(db, Date.parse('2026-10-03'));
    expect(fit.evidence([survivor!.id, members[1]!.id])).toEqual({ playedSets: 1, eventDays: 1 });
    expect(
      fit.rating([survivor!.id, members[1]!.id], Date.parse('2026-10-03') / 86400000).adjustment,
    ).not.toBe(0);
    expect(fit.evidence([survivor!.id, members[2]!.id])).toEqual({ playedSets: 0, eventDays: 0 });
    expect(
      fit.rating([survivor!.id, members[2]!.id], Date.parse('2026-10-03') / 86400000).adjustment,
    ).toBe(0);
  });
  it('seeds from singles skill rather than ranks, freezes provenance, and withholds later singles results', async () => {
    const { planId, members } = await draft(2, 'round_robin');
    const addSingles = async (date: string, reverse = false) => {
      const [t] = await db
        .insert(tournaments)
        .values({
          provider: 'native',
          name: 'Singles calibration',
          challongeSlug: `calibration_${crypto.randomUUID()}`,
          eventDate: new Date(date),
          challongeState: 'complete',
          syncState: 'synced',
        })
        .returning();
      await db.insert(sets).values(
        Array.from({ length: 20 }, (_, i) => ({
          tournamentId: t!.id,
          challongeMatchId: i + 1,
          state: 'complete',
          p1PlayerId: members[0]!.id,
          p2PlayerId: members[2]!.id,
          winner: reverse ? 2 : 1,
          scoresCsv: reverse ? '0-2' : '2-0',
        })),
      );
    };
    await addSingles('2026-09-01T00:00:00Z');
    await runRecompute(db);
    const before = (await caller().admin.eventPlanner.plan({ planId }))!;
    expect(before.entries[0]!.currentMean).toBeGreaterThan(1500);
    expect(before.entries[1]!.currentMean).toBeLessThan(1500);
    await caller().admin.eventPlanner.freezeRoster({ planId });
    const frozen = (await caller().admin.eventPlanner.plan({ planId }))!;
    await addSingles('2026-10-09T00:00:00Z', true);
    await runRecompute(db);
    const later = (await caller().admin.eventPlanner.plan({ planId }))!;
    expect(later.entries.map((e) => [e.snapshotMean, e.snapshotSd, e.divisionSeed])).toEqual(
      frozen.entries.map((e) => [e.snapshotMean, e.snapshotSd, e.divisionSeed]),
    );
    expect(later.entries.map((e) => e.currentMean)).toEqual(
      before.entries.map((e) => e.currentMean),
    );
    await caller().admin.eventPlanner.generatePools({ planId });
    await caller().eventOps.softLockPools({ planId, confirm: true });
    const baseline = (await runtime.state(planId)).baseline!;
    expect(baseline.ratingContext.doubles?.model).toBe('whr-pair-residual-v1');
    expect(baseline.ratingContext.doubles?.sourceResultIds).toEqual([]);
  });
  it('explains cold-pair seed changes, excludes same-day history, and freezes the exact breakdown', async () => {
    const { planId, members } = await draft(2, 'round_robin', '2026-09-29T00:00:00Z');
    const [opponent] = await db
      .insert(players)
      .values({ canonicalName: 'Singles baseline opponent' })
      .returning();
    const [singles] = await db
      .insert(tournaments)
      .values({
        provider: 'native',
        name: 'Earlier singles',
        challongeSlug: `cold_pair_${crypto.randomUUID()}`,
        eventDate: new Date('2026-09-01'),
        challongeState: 'complete',
        syncState: 'synced',
      })
      .returning();
    await db.insert(sets).values(
      Array.from({ length: 20 }, (_, i) => ({
        tournamentId: singles!.id,
        challongeMatchId: i + 1,
        state: 'complete',
        p1PlayerId: members[i % 2]!.id,
        p2PlayerId: opponent!.id,
        winner: 1,
        scoresCsv: '2-0',
      })),
    );
    const off = (await caller().admin.eventPlanner.plan({ planId }))!;
    await caller().admin.eventPlanner.updateNativeFormat({
      planId,
      structure: 'round_robin',
      usePairRatings: true,
    });
    const on = (await caller().admin.eventPlanner.plan({ planId }))!;
    for (let i = 0; i < on.entries.length; i++) {
      const entry = on.entries[i]!,
        previous = off.entries[i]!;
      expect(entry.currentMean).toBe(previous.currentMean);
      expect(entry.currentScore).toBeLessThan(previous.currentScore!);
      expect(entry.currentScore).toBeCloseTo(entry.currentMean! - 2 * entry.currentSd!, 10);
      expect(entry.currentSd! ** 2).toBeCloseTo(
        previous.currentSd! ** 2 + ((0.25 * 400) / Math.log(10)) ** 2,
        7,
      );
      expect(entry.pairRating).toMatchObject({
        enabled: true,
        adjustment: 0,
        playedSets: 0,
        eventDays: 0,
      });
      expect(previous.pairRating).toMatchObject({ enabled: false, adjustment: 0, adjustmentSd: 0 });
    }
    // Different baseline SDs give different seed changes despite identical zero mean adjustments.
    expect(on.entries[0]!.currentScore! - off.entries[0]!.currentScore!).not.toBeCloseTo(
      on.entries[1]!.currentScore! - off.entries[1]!.currentScore!,
      3,
    );
    await caller().admin.eventPlanner.freezeRoster({ planId });
    const frozen = (await caller().admin.eventPlanner.plan({ planId }))!;
    expect(frozen.entries.map((e) => e.pairRating)).toEqual(on.entries.map((e) => e.pairRating));

    const { planId: earlier } = await caller().admin.eventPlanner.createPlan({
      competitionFormat: 'doubles',
      bracketMode: 'native',
      structure: 'round_robin',
      name: 'Earlier doubles sealed later',
      eventDate: '2026-09-28T00:00:00Z',
      rows: [],
    });
    for (let i = 0; i < 2; i++)
      await caller().admin.eventPlanner.addDoublesPair({
        planId: earlier,
        playerId: members[i * 2]!.id,
        partnerPlayerId: members[i * 2 + 1]!.id,
      });
    await prepare(earlier);
    await finishPools(earlier);
    await caller().eventOps.native.finalize({ planId: earlier });
    const pair = [members[0]!.id, members[1]!.id] as const;
    const sameDay = await loadDoublesRatings(db, Date.parse('2026-09-28T23:00:00Z'));
    expect(sameDay.evidence(pair).playedSets).toBe(0);
    expect(sameDay.rating(pair, Date.parse('2026-09-28') / 86400000).adjustment).toBe(0);
    const previousDay = await loadDoublesRatings(db, Date.parse('2026-09-27'));
    expect(previousDay.evidence(pair).playedSets).toBe(0);
    const nextDay = await loadDoublesRatings(db, Date.parse('2026-09-29'));
    expect(nextDay.evidence(pair)).toEqual({ playedSets: 1, eventDays: 1 });
    expect(nextDay.rating(pair, Date.parse('2026-09-29') / 86400000).adjustment).not.toBe(0);
    const later = (await caller().admin.eventPlanner.plan({ planId }))!;
    expect(later.plan.nativeSeedContext).toEqual(frozen.plan.nativeSeedContext);
    expect(
      later.entries.map((e) => [
        e.snapshotMean,
        e.snapshotSd,
        e.snapshotScore,
        e.divisionSeed,
        e.pairRating,
      ]),
    ).toEqual(
      frozen.entries.map((e) => [
        e.snapshotMean,
        e.snapshotSd,
        e.snapshotScore,
        e.divisionSeed,
        e.pairRating,
      ]),
    );
    const { pairs: _pairs, ...oldContext } = frozen.plan.nativeSeedContext!;
    await db
      .update(eventPlans)
      .set({ nativeSeedContext: oldContext })
      .where(eq(eventPlans.id, planId));
    const old = (await caller().admin.eventPlanner.plan({ planId }))!;
    expect(old.entries.every((e) => e.pairRating === undefined)).toBe(true);
    expect(old.entries.map((e) => e.snapshotScore)).toEqual(
      frozen.entries.map((e) => e.snapshotScore),
    );
  });
});

describe('doubles domain invariants', () => {
  function baseline() {
    const b = pureBaseline();
    b.version = 2;
    b.competitionFormat = 'doubles';
    b.structure = 'dual_division';
    for (const e of b.entrants) e.memberPlayerIds = [stableId(`${e.id}:a`), stableId(`${e.id}:b`)];
    return b;
  }
  it('rejects a person appearing in two pairs and an incomplete pair', () => {
    const b = baseline();
    b.entrants[1]!.memberPlayerIds![0] = b.entrants[0]!.memberPlayerIds![1]!;
    expect(() => captureBaseline(b)).toThrow(/more than once/);
    const incomplete = baseline();
    incomplete.entrants[0]!.memberPlayerIds!.pop();
    expect(() => captureBaseline(incomplete)).toThrow(/membership/);
  });
  it('holds a match when either member snoozes and retains replayable individual availability', () => {
    let state = captureBaseline(baseline());
    const e = state.entrants[0]!,
      member = e.memberPlayerIds![1]!;
    state = reduceDecision(
      state,
      decide(
        state,
        envelope({
          kind: 'availability',
          playerId: member,
          availability: 'snoozed',
          expectedRevision: 0,
          reason: 'Away',
        }),
      )!,
    );
    const match = state.matches.find((m) => [m.player1Id, m.player2Id].includes(e.playerId))!;
    expect(() =>
      decide(
        state,
        envelope({
          kind: 'dispatch',
          matchId: match.id,
          stationId: null,
          expectedRevision: match.revision,
          expectedResourceRevision: state.settings.resourceRevision,
        }),
      ),
    ).toThrow(/unavailable/);
    expect(state.entrants[0]!.availability).toBe('available');
    expect(state.entrants[0]!.memberAvailability?.[member]).toBe('snoozed');
  });
  it('keeps legacy V1 baseline hashes and replay unchanged', () => {
    const b = pureBaseline();
    expect(hash(Baseline.parse(b))).toBe(hash(b));
    expect(captureBaseline(Baseline.parse(b))).toEqual(captureBaseline(b));
  });
});
