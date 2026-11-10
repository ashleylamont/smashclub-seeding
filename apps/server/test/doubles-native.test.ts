import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryStore } from '@rotorsoft/act';
import { eq } from 'drizzle-orm';
import {
  eventOperators,
  eventPlanEntries,
  playerCharacters,
  eventPlans,
  eventOperationSettings,
  ratingEvents,
  players,
  sets,
  tournamentParticipants,
  tournaments,
  user,
  type Db,
} from '@smashclub/db';
import {
  expectDoublesRecapAndHistory,
  expectDoublesFinalsMembership,
  publishedPlayerRating,
} from './helpers/doublesRecapAssertions';
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
  const caller = (actor: typeof nativeAdmin | null = nativeAdmin) =>
    appRouter.createCaller({
      db,
      user: actor,
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
    it(`runs ${count} pairs in ${structure}, publishes one fact per set and rates each team member`, async () => {
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
      const member = members[0]!;
      await db.insert(playerCharacters).values([
        { playerId: member.id, position: 1, characterSlug: 'luigi' },
        { playerId: member.id, position: 0, characterSlug: 'mario' },
      ]);
      const to = { ...nativeAdmin, id: `graphic-to-${planId}`, role: 'user' as const };
      await db.insert(user).values({ ...to, email: `${to.id}@example.test` });
      await db.insert(eventOperators).values({ eventPlanId: planId, userId: to.id });
      expect(
        await caller(to).eventOps.canCustomizeResultGraphic({
          tournamentIds: [...publishedIds],
        }),
      ).toBe(true);
      await expect(
        caller(null).eventOps.canCustomizeResultGraphic({
          tournamentIds: [...publishedIds],
        }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      const event = await caller(null).public.eventOverview({ slug: tournament!.challongeSlug });
      expect(
        event!.divisions.flatMap((d) => d.players).find((p) => p.graphic?.teamName === 'Pair 0')
          ?.graphic,
      ).toEqual({
        teamName: 'Pair 0',
        members: [
          { name: member.displayName, character: 'mario' },
          { name: members[1]!.displayName, character: null },
        ],
      });
      expect(event!.warnings).toEqual([]);
      expect(event!.divisions.every((d) => d.notice === null)).toBe(true);
      expect(event!.divisions.flatMap((d) => d.players)).toHaveLength(count);
      expect(event!.divisions.flatMap((d) => d.players).every((p) => p.place !== null)).toBe(true);
      expect(JSON.stringify(event)).not.toContain('Private Surname');
      const api = caller().public;
      await expectDoublesFinalsMembership(api, tournament!.challongeSlug, complete.result!);
      const detail = await api.tournament({ slug: tournament!.challongeSlug });
      expect(detail!.participants[0]!.name).toContain(' / ');
      expect(detail!.participants[0]!.name).toMatch(/^Pair \d+ \(/);
      expect(JSON.stringify(detail)).not.toContain('Private Surname');
      await processNativeRatingIntents(db);
      const recompute = await runRecompute(db);
      const ratedRows = (
        await db
          .select()
          .from(ratingEvents)
          .where(eq(ratingEvents.recomputeId, recompute.recomputeId))
      ).filter((row) => publishedIds.has(row.tournamentId));
      expect(ratedRows).toHaveLength(
        historical.filter((row) => !row.excludedFromRatings).length * 4,
      );
      expect(new Set(ratedRows.map((row) => row.playerId))).toEqual(
        new Set(members.map(({ id }) => id)),
      );
      expect(ratedRows.every((row) => row.opponentPlayerId === null)).toBe(true);
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
  it('holds both members’ matches consistently and rejects doubles through the singles Add path', async () => {
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
    expect(preview.issues.join(' ')).toMatch(/late-pair workflow/);
  });
  it('substitutes one member in the same pool slot without moving or reattributing recorded results', async () => {
    const { planId } = await draft(8, 'pools_finals');
    await expect(
      caller().eventOps.previewDoublesSubstitution({
        planId,
        entrantId: crypto.randomUUID(),
        outgoingPlayerId: crypto.randomUUID(),
        incomingPlayerId: crypto.randomUUID(),
        reason: 'Do not adopt a draft',
      }),
    ).rejects.toThrow(/soft-locked/);
    expect((await runtime.state(planId)).baseline).toBeNull();
    await prepare(planId);
    const operator = caller(),
      guest = caller(null);
    const [incoming] = await db
      .insert(players)
      .values({ canonicalName: 'Private Substitute', displayName: 'Substitute Alias' })
      .returning();
    const locked = await runtime.state(planId);
    const entrant = locked.entrants.find((e) => e.playerId === locked.pools[0]!.entrantIds[0])!;
    const oldMemberIds = entrant.memberPlayerIds!;
    const match = locked.matches.find((m) => [m.player1Id, m.player2Id].includes(entrant.id))!;
    const other = locked.matches.find(
      (m) => m.poolId === match.poolId && ![m.player1Id, m.player2Id].includes(entrant.id),
    )!;
    const change = {
      planId,
      entrantId: entrant.id,
      outgoingPlayerId: oldMemberIds[1]!,
      incomingPlayerId: incoming!.id,
      reason: 'The original partner could not attend',
    };
    await expect(guest.eventOps.previewDoublesSubstitution(change)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    const attendee = caller({ ...nativeAdmin, id: 'substitution-attendee', role: 'user' as const });
    await expect(attendee.eventOps.previewDoublesSubstitution(change)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const duplicate = await operator.eventOps.previewDoublesSubstitution({
      ...change,
      incomingPlayerId: locked.entrants.find((e) => e.id !== entrant.id)!.memberPlayerIds![0]!,
    });
    expect(duplicate.issues.join(' ')).toMatch(/already has an entry/);
    const held = locked.matches.find(
      (m) => m.id !== match.id && [m.player1Id, m.player2Id].includes(entrant.id),
    )!;
    await operator.eventOps.updateMatch({
      matchId: held.id,
      expectedRevision: held.revision,
      status: 'blocked',
      blockedReason: 'Keep this TO hold',
    });
    await operator.eventOps.guests.configure({ planId, enabled: true, showOnOverlay: false });
    const invitation = (await operator.eventOps.guests.invitation({ planId }))!;
    const { sessionToken } = await guest.eventOps.guests.redeem({
      planId,
      token: invitation.token,
    });
    const preview = await operator.eventOps.previewDoublesSubstitution(change);
    expect(preview).toMatchObject({
      allowed: true,
      seed: entrant.seed,
      poolIndex: locked.pools[0]!.index,
      newMembers: [preview.oldMembers![0], 'Substitute Alias'],
      affectedMatchCount: 3,
    });
    await operator.eventOps.reportScore({
      matchId: other.id,
      expectedRevision: other.revision,
      requestId: 'unaffected-same-pool-result',
      score1: 2,
      score2: 1,
      outcome: 'played',
    });
    const before = await runtime.state(planId);
    const submission = {
      ...change,
      requestId: 'reviewed-substitution',
      revisionToken: preview.revisionToken,
    };
    const result = await operator.eventOps.applyDoublesSubstitution(submission);
    expect(await operator.eventOps.applyDoublesSubstitution(submission)).toEqual(result);
    await expect(
      operator.eventOps.applyDoublesSubstitution({ ...submission, reason: 'Different reason' }),
    ).rejects.toThrow(/already used/);

    const after = await runtime.state(planId);
    expect(after.baseline).toEqual(locked.baseline);
    expect(after.pools).toEqual(before.pools);
    expect(after.reports).toEqual(before.reports);
    expect(after.matches).toEqual(
      before.matches.map((m) =>
        [m.player1Id, m.player2Id].includes(entrant.id) ? { ...m, revision: m.revision + 1 } : m,
      ),
    );
    const newMemberIds = [oldMemberIds[0], incoming!.id];
    expect(after.entrants.find((e) => e.id === entrant.id)).toMatchObject({
      playerId: entrant.playerId,
      seed: entrant.seed,
      division: entrant.division,
      memberPlayerIds: newMemberIds,
      memberSubstituted: true,
      snapshotScore: null,
      snapshotMean: null,
      snapshotSd: null,
      snapshotRank: null,
    });
    const privatePlan = (await operator.admin.eventPlanner.plan({ planId }))!;
    const entry = privatePlan.entries.find((e) => e.id === entrant.id)!;
    expect(entry).toMatchObject({
      primaryPlayerId: oldMemberIds[0],
      partnerPlayerId: incoming!.id,
      memberPlayerIds: newMemberIds,
      divisionSeed: entrant.seed,
      memberSubstituted: true,
      currentScore: null,
    });
    expect(entry.pairRating).toBeUndefined();
    const roster = await operator.eventOps.attendeeRoster({ planId });
    expect(roster.attendees.filter((row) => row.entryId === entrant.id)).toMatchObject([
      { playerId: oldMemberIds[0], rawInput: entrant.name },
      { playerId: incoming!.id, rawInput: entrant.name },
    ]);
    const guestBoard = await guest.eventOps.guests.matches({ planId, sessionToken });
    if (!('entrants' in guestBoard)) throw new Error('Expected the native guest board.');
    const publicPair = guestBoard.entrants.find((e) => e.id === entrant.id)!;
    expect(publicPair).toMatchObject({ memberPlayerIds: newMemberIds });
    expect(publicPair.name).toContain('Substitute Alias');
    expect(JSON.stringify(guestBoard)).not.toContain('Private Substitute');

    const score = {
      matchId: match.id,
      expectedRevision: match.revision,
      requestId: 'old-pair-score-form',
      score1: 2,
      score2: 0,
    };
    await expect(attendee.eventOps.reportScore({ ...score, outcome: 'played' })).rejects.toThrow(
      /changed/,
    );
    await expect(guest.eventOps.guests.submit({ planId, sessionToken, ...score })).rejects.toThrow(
      /changed/,
    );
    expect((await runtime.state(planId)).reports).toEqual(before.reports);
    const audit = (await operator.eventOps.live.history({ planId })).entries.filter(
      ({ title }) => title === 'Doubles substitute confirmed',
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ eventName: 'DecisionRecordedV8', actor: nativeAdmin.name });
    expect(audit[0]!.summary).toContain(
      `${preview.oldMembers!.join(' / ')} → ${preview.newMembers!.join(' / ')}`,
    );
    expect(audit[0]!.summary).toContain(change.reason);
    expect(await runtime.replay(planId)).toEqual(after);

    await operator.eventOps.updateMatch({
      matchId: held.id,
      expectedRevision: held.revision + 1,
      status: 'ready',
    });
    await finishPools(planId);
    const draw = { planId, seedPolicy: 'pool_place_whr_v1' as const };
    const finals = await operator.eventOps.native.preview(draw);
    expect(finals.allowed).toBe(true);
    await operator.eventOps.native.generate({ ...draw, revisionToken: finals.revisionToken });
    const frozen = await operator.eventOps.previewDoublesSubstitution({
      ...change,
      outgoingPlayerId: incoming!.id,
      incomingPlayerId: oldMemberIds[1]!,
    });
    expect(frozen.allowed).toBe(false);
    expect(frozen.issues.join(' ')).toMatch(/qualification has already been confirmed or used/);
    const drawn = await runtime.state(planId);
    const qualifier = drawn.brackets
      .flatMap((b) => b.strengthSeeding?.seeds ?? [])
      .find((s) => s.playerId === entrant.id);
    expect(qualifier).toMatchObject({ strengthSource: 'prior' });
    await scoreReady(planId);
    await operator.eventOps.native.finalize({ planId });
    const sealed = await runtime.state(planId);
    const historical = (await db.select().from(tournamentParticipants)).filter((p) =>
      sealed.publication!.tournamentIds.includes(p.tournamentId),
    );
    expect(historical.some((p) => p.memberPlayerIds?.includes(incoming!.id))).toBe(true);
    expect(historical.some((p) => p.memberPlayerIds?.includes(oldMemberIds[1]!))).toBe(false);
    expect(sealed.result?.matches.find((m) => m.id === other.id)).toEqual(
      before.matches.find((m) => m.id === other.id),
    );
  });

  it('requires explicit return of untaken calls and rejects reports or previously started matches', async () => {
    const { planId } = await draft(4, 'round_robin');
    await prepare(planId);
    const [incoming] = await db
      .insert(players)
      .values({ canonicalName: 'Another Substitute' })
      .returning();
    expect(
      await verifyUntakenCallAndReportGuards(planId, incoming!.id, runtime, caller),
    ).toMatchObject({ status: 'ready', started: true });
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
    const beforeIndividual = await publishedPlayerRating(db, members[0]!.id);
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
    const afterIndividual = await publishedPlayerRating(db, members[0]!.id);
    expect(afterIndividual?.matchCount).toBe(beforeIndividual?.matchCount);
    expect(afterIndividual!.rating).toBeLessThan(beforeIndividual!.rating);
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
    await expectDoublesRecapAndHistory(
      caller(null).public,
      t!.challongeSlug,
      members[7]!.id,
      members[6]!.displayName,
    );
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

async function verifyUntakenCallAndReportGuards(
  planId: string,
  incomingPlayerId: string,
  runtime: NativeRuntime,
  caller: (actor?: typeof nativeAdmin | null) => ReturnType<typeof appRouter.createCaller>,
) {
  const operator = caller();
  const state = await runtime.state(planId);
  const match = state.matches[0]!,
    entrant = state.entrants.find((e) => e.id === match.player1Id)!;
  const change = {
    planId,
    entrantId: entrant.id,
    outgoingPlayerId: entrant.memberPlayerIds![1]!,
    incomingPlayerId,
    reason: 'Emergency substitute',
  };
  const initial = await operator.eventOps.previewDoublesSubstitution(change);
  expect(initial.allowed).toBe(true);
  const command = (command: Parameters<typeof operator.eventOps.live.command>[0]['command']) =>
    operator.eventOps.live.command({ planId, command, requestId: crypto.randomUUID() });
  await command({
    kind: 'configureDispatch',
    capacity: 1,
    reservedStationIds: [],
    expectedResourceRevision: state.settings.resourceRevision,
  });
  const dispatch = async () =>
    command({
      kind: 'dispatch',
      matchId: match.id,
      expectedRevision: match.revision,
      expectedResourceRevision: (await runtime.state(planId)).settings.resourceRevision,
      stationId: null,
      callOnly: true,
    });
  const returnCall = async () =>
    operator.eventOps.updateMatch({
      matchId: match.id,
      expectedRevision: match.revision,
      status: 'ready',
      stationId: null,
    });
  await dispatch();
  await expect(
    operator.eventOps.applyDoublesSubstitution({
      ...change,
      requestId: 'stale-after-call',
      revisionToken: initial.revisionToken,
    }),
  ).rejects.toThrow(/changed since this preview/);
  expect(await operator.eventOps.previewDoublesSubstitution(change)).toMatchObject({
    allowed: false,
    returnCallMatchIds: [match.id],
  });
  await returnCall();
  expect((await operator.eventOps.previewDoublesSubstitution(change)).allowed).toBe(true);

  const reporting = await runtime.state(planId);
  await command({
    kind: 'reporting',
    published: true,
    playerReports: true,
    mode: 'to_review',
    expectedRevision: reporting.settings.reportingRevision,
  });
  const attendee = caller({
    ...nativeAdmin,
    id: 'substitution-pending-report',
    role: 'user' as const,
  });
  const other = state.matches.find(
    (m) => m.id !== match.id && [m.player1Id, m.player2Id].includes(entrant.id),
  )!;
  const report = await attendee.eventOps.reportScore({
    matchId: other.id,
    expectedRevision: other.revision,
    requestId: 'pending-before-substitution',
    score1: 2,
    score2: 0,
    outcome: 'played',
  });
  await operator.eventOps.reviewReport({ reportId: report.id, approve: false });
  const rejected = await operator.eventOps.previewDoublesSubstitution(change);
  expect(rejected.allowed).toBe(false);
  expect(rejected.issues.join(' ')).toMatch(/score report/);

  await dispatch();
  await command({
    kind: 'beginPlay',
    matchId: match.id,
    expectedRevision: match.revision,
    expectedResourceRevision: (await runtime.state(planId)).settings.resourceRevision,
  });
  await returnCall();
  const started = await operator.eventOps.previewDoublesSubstitution({
    ...change,
    entrantId: match.player2Id!,
    outgoingPlayerId: state.entrants.find((e) => e.id === match.player2Id)!.memberPlayerIds![0]!,
  });
  expect(started.allowed).toBe(false);
  expect(started.returnCallMatchIds).toEqual([]);
  expect(started.issues.join(' ')).toMatch(/recorded play/);
  return (await runtime.state(planId)).matches.find(({ id }) => id === match.id);
}
