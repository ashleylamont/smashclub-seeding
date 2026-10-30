import { eliminationStandings, buildFormatFinals, seedPoolFinishers } from '@smashclub/engine';
import { available, memberIds, publicEntrantNames } from './entrants';
import { asc, inArray } from 'drizzle-orm';
import { players, playerCharacters, tournaments, type Db, type eventMatches } from '@smashclub/db';
import { publicPlayerName } from '@smashclub/shared';
import { buildStationQueues } from '../event-operations/queue';
import { matchAvailability, stationAvailability } from '../event-operations/availability';
import type { snapshot as sqlSnapshot } from '../event-operations/service';
import { getPlan as sqlPlan, type PlanView } from '../event-planner/plans';
import { resolved } from './facts';
import { hasCurrentPendingScoreReview } from './scoreReview';
import type { TournamentState } from './schemas';

export type EventSnapshot = Awaited<ReturnType<typeof sqlSnapshot>>;
export function matchRows(state: TournamentState): (typeof eventMatches.$inferSelect & {
  parent1Outcome?: 'winner' | 'loser';
  parent2Outcome?: 'winner' | 'loser';
  bracketLane?: string;
  bracketRound?: number;
  player1MemberIds?: string[];
  player2MemberIds?: string[];
})[] {
  return state.matches
    .filter((m) => !m.skipped)
    .map((m) => ({
      id: m.id,
      eventPlanId: state.baseline!.planId,
      sourceKey: m.sourceKey,
      sourceSetId: null,
      division: m.division,
      stage: m.stage,
      poolIndex: state.pools.find((p) => p.id === m.poolId)?.index ?? null,
      label: m.label,
      player1Id: m.player1Id,
      player1MemberIds: state.entrants.find((e) => e.playerId === m.player1Id)?.memberPlayerIds,
      player2MemberIds: state.entrants.find((e) => e.playerId === m.player2Id)?.memberPlayerIds,
      player2Id: m.player2Id,
      score1: m.score1,
      score2: m.score2,
      liveScore1: m.liveScore1,
      liveScore2: m.liveScore2,
      winnerId: m.winnerId,
      outcome: m.outcome === 'no_contest' ? null : m.outcome,
      status: m.status,
      stationId: m.stationId,
      blockedReason:
        m.outcome === 'no_contest'
          ? 'Both players withdrawn: no contest; no winner or score recorded'
          : (m.blockedReason ??
            (m.status === 'blocked' ? 'Waiting for previous round winners' : null)),
      resultUpdatedAt: m.completedAt === null ? null : new Date(m.completedAt),
      revision: m.revision,
      syncState: 'local',
      nativeBracketId: m.bracketId,
      nativeRound: m.round || null,
      nativeSlot: m.round ? m.slot : null,
      parent1Outcome: m.parent1Outcome,
      parent2Outcome: m.parent2Outcome,
      bracketLane: m.bracketLane,
      bracketRound: m.bracketRound,
      parent1MatchId: m.parent1Id,
      parent2MatchId: m.parent2Id,
    }));
}
export function schedules(state: TournamentState) {
  return state.pools.map((p) => ({
    id: p.id,
    eventPlanId: state.baseline!.planId,
    division: p.division,
    poolIndex: p.index,
    active: p.active,
    stationIds: p.stationIds,
    selfRun: p.selfRun,
    autoAcceptScores: p.autoAcceptScores,
    revision: p.scheduleRevision,
  }));
}
export function bracketViews(state: TournamentState) {
  return state.brackets.map((b) => {
    const rounds = state.matches.filter((m) => m.bracketId === b.id);
    const roundRobin = state.baseline!.structure === 'round_robin';
    const order = roundRobin ? state.pools[0]?.order : null;
    const outcome = eliminationStandings(
      b.entrantIds,
      rounds,
      state.baseline!.structure === 'double_elimination',
    );
    const complete = roundRobin
      ? Boolean(order && state.matches.every(resolved))
      : outcome.complete;
    const winnerId = complete ? (roundRobin ? (order?.[0] ?? null) : outcome.winnerId) : null;
    const standings =
      roundRobin && complete
        ? (order ?? []).map((playerId, i) => ({ playerId, place: i + 1 }))
        : outcome.standings;
    return {
      ...b,
      eventPlanId: state.baseline!.planId,
      createdAt: new Date(state.baseline!.capturedAt),
      complete,
      winnerId,
      standings: standings.sort((a, b) => a.place - b.place),
    };
  });
}
export async function eventView(db: Db, state: TournamentState): Promise<EventSnapshot> {
  const baseline = state.baseline!;
  const planId = baseline.planId;
  const allPlayers = await db.select().from(players);
  const names = publicEntrantNames(allPlayers, state.entrants);
  const ids = state.entrants.flatMap(memberIds);
  const characters = ids.length
    ? await db
        .select()
        .from(playerCharacters)
        .where(inArray(playerCharacters.playerId, ids))
        .orderBy(asc(playerCharacters.position))
    : [];
  const rows = matchRows(state);
  const pendingReviewIds = new Set(
    rows
      .filter((match) => hasCurrentPendingScoreReview(match, state.reports))
      .map((match) => match.id),
  );
  const stations = state.stations
    .filter((s) => s.enabled)
    .map((s) => ({ id: s.id, name: s.name, eventPlanId: planId }));
  const poolSchedules = schedules(state);
  const open = state.lifecycle === 'locked';
  const historical = state.publication?.tournamentIds.length
    ? await db
        .select()
        .from(tournaments)
        .where(inArray(tournaments.id, state.publication.tournamentIds))
    : [];
  return {
    ...buildStationQueues(
      rows,
      stations,
      poolSchedules,
      state.entrants.filter((e) => !available(e)).map((e) => e.playerId),
      open,
      pendingReviewIds,
    ),
    members:
      state.baseline?.competitionFormat === 'doubles'
        ? state.entrants.flatMap((e) =>
            memberIds(e).map((id) => ({
              entrantId: e.playerId,
              playerId: id,
              name: names.get(id) ?? 'Player',
              availability: e.memberAvailability?.[id] ?? 'available',
              revision: e.revision,
            })),
          )
        : undefined,
    nativeBrackets: bracketViews(state),
    plan: {
      id: planId,
      liveOwned: true,
      drawPaused: state.lifecycle === 'unlocked',
      name: baseline.name,
      eventDate: new Date(baseline.eventDate).toISOString(),
      status:
        state.lifecycle === 'finalized'
          ? 'complete'
          : state.lifecycle === 'cancelled'
            ? 'cancelled'
            : 'underway',
      bracketMode: 'native',
      competitionFormat: baseline.competitionFormat ?? 'singles',
      structure: baseline.structure ?? 'dual_division',
      structureOptions: baseline.structureOptions,
      softLockedAt: new Date(baseline.capturedAt).toISOString(),
      historicalResultsSlug: null,
      resultsSlug:
        historical.find(
          (t) =>
            (t.raw as { eventPlanId?: string; division?: string })?.eventPlanId === planId &&
            t.challongeSlug.includes('_upper_main'),
        )?.challongeSlug ?? null,
    },
    brackets: historical.map((t) => ({
      division: t.challongeSlug.includes('_upper_') ? ('upper' as const) : ('lower' as const),
      stage: t.challongeSlug.includes('_main') ? ('main' as const) : ('consolation' as const),
      slug: t.challongeSlug,
    })),
    settings: state.settings,
    matches: rows.map((m) => ({
      ...m,
      resourceRevision: state.settings.resourceRevision,
      progressRevision: state.matches.find((row) => row.id === m.id)!.progressRevision,
      started: state.matches.find((row) => row.id === m.id)!.started,
      score1: m.status === 'playing' ? (m.liveScore1 ?? m.score1) : m.score1,
      score2: m.status === 'playing' ? (m.liveScore2 ?? m.score2) : m.score2,
      pendingDisputeCount: state.reports.filter(
        (r) => r.matchId === m.id && r.status === 'pending' && r.isDispute,
      ).length,
      player1Name: m.player1Id ? (names.get(m.player1Id) ?? 'Player') : 'TBD',
      player2Name: m.player2Id ? (names.get(m.player2Id) ?? 'Player') : 'TBD',
      player1Characters: characters
        .filter((c) => (m.player1MemberIds ?? [m.player1Id]).includes(c.playerId))
        .map((c) => c.characterSlug),
      player2Characters: characters
        .filter((c) => (m.player2MemberIds ?? [m.player2Id]).includes(c.playerId))
        .map((c) => c.characterSlug),
      availability: (() => {
        const value = matchAvailability(m, rows, stations, poolSchedules, false, open);
        if (pendingReviewIds.has(m.id)) {
          value.canStart = false;
          value.reasons.push({
            code: 'score_review_pending',
            message: 'This match has a score awaiting TO review.',
          });
        }
        if (
          state.entrants.some(
            (e) => [m.player1Id, m.player2Id].includes(e.playerId) && !available(e),
          )
        ) {
          value.canStart = false;
          value.reasons.push({
            code: 'member_unavailable',
            message: 'An entrant or team member is unavailable.',
          });
        }
        return value;
      })(),
    })),
    entrants: state.entrants.map((e) => ({
      id: e.playerId,
      name: names.get(e.playerId) ?? 'Player',
      memberPlayerIds: e.memberPlayerIds,
    })),
    prizes: state.prizes.map((p) => ({
      ...p,
      eventPlanId: planId,
      playerName: p.playerId ? (names.get(p.playerId) ?? 'Player') : null,
    })),
    announcements: [...state.announcements]
      .reverse()
      .sort((a, b) => b.createdAt - a.createdAt)
      .filter((a) => !a.expiresAt || a.expiresAt > Date.now())
      .map((a) => ({
        ...a,
        eventPlanId: planId,
        createdAt: new Date(a.createdAt).toISOString(),
        expiresAt: a.expiresAt ? new Date(a.expiresAt).toISOString() : null,
      })),
    stations: stations.map((s) => stationAvailability(s, rows)),
    poolSchedules,
    withdrawals: state.entrants
      .filter((e) => e.availability === 'withdrawn')
      .map((e) => ({ playerId: e.playerId })),
    placements: state.pools.flatMap((p) =>
      (p.order ?? []).map((playerId, i) => ({
        id: `${p.id}:${playerId}`,
        eventPlanId: planId,
        division: p.division,
        poolIndex: p.index,
        playerId,
        place: i + 1,
        source: 'manual' as const,
        createdAt: new Date(baseline.capturedAt),
        updatedAt: new Date(baseline.capturedAt),
      })),
    ),
  };
}

export async function planView(db: Db, state: TournamentState): Promise<PlanView> {
  const draft = (await sqlPlan(db, state.baseline!.planId))!;
  const profiles = new Map((await db.select().from(players)).map((p) => [p.id, p]));
  const entries = state.entrants.map((e, i) => {
    const old = draft.entries.find((old) => old.id === e.id);
    const p = profiles.get(e.playerId);
    const pairProfiles = e.memberPlayerIds
      ?.map((id) => profiles.get(id))
      .filter((p) => p !== undefined);
    const pairName = pairProfiles?.map(publicPlayerName).join(' / ');
    return {
      ...old,
      id: e.id,
      sourceLineNumber: old?.sourceLineNumber ?? i + 1,
      rawInput: old?.rawInput ?? e.name,
      cleanedName: old?.cleanedName ?? e.name,
      companyCode: old?.companyCode ?? null,
      playerId: e.playerId,
      playerName: p?.canonicalName ?? e.name,
      publicName: pairName
        ? `${e.teamName ? `${e.teamName} (` : ''}${pairName}${e.teamName ? ')' : ''}`
        : p
          ? publicPlayerName(p)
          : 'Player',
      playerStatus: p?.status ?? 'active',
      resolutionMethod: old?.resolutionMethod ?? 'manual',
      divisionPreference: old?.divisionPreference ?? 'auto',
      assignedDivision: e.division,
      divisionSeed: e.seed,
      snapshotRank: e.snapshotRank,
      snapshotScore: e.snapshotScore,
      currentRank: old?.currentRank ?? null,
      currentScore: old?.currentScore ?? null,
      lastPlayedDate: old?.lastPlayedDate ?? null,
      withdrawn: e.availability === 'withdrawn',
      candidates: old?.candidates ?? [],
    };
  });
  const divisions = (
    state.baseline!.structure && state.baseline!.structure !== 'dual_division'
      ? (['upper'] as const)
      : (['upper', 'lower'] as const)
  ).map((division) => {
    const pools = state.pools
      .filter((p) => p.division === division)
      .map((p) => ({
        poolIndex: p.index,
        label: `Pool ${p.index + 1}`,
        placementRevision: String(p.revision),
        matchRevisions: state.matches
          .filter((m) => m.poolId === p.id)
          .map((m) => ({ id: m.id, revision: m.revision })),
        members: p.entrantIds.map((playerId) => {
          const e = entries.find((e) => e.playerId === playerId)!;
          return {
            entryId: e.id,
            playerId,
            name: e.publicName,
            seed: e.divisionSeed,
            snapshotRank: e.snapshotRank,
            place: p.order ? p.order.indexOf(playerId) + 1 : null,
            withdrawn: e.withdrawn,
          };
        }),
      }));
    const ordered = state.pools.filter((p) => p.division === division).every((p) => p.order);
    const finishers = pools.flatMap((p) =>
      p.members
        .filter((m) => !m.withdrawn)
        .sort((a, b) => a.place! - b.place!)
        .map((m, i) => ({ playerId: m.playerId, poolIndex: p.poolIndex, place: i + 1 })),
    );
    const consolation = buildFormatFinals(
      state.baseline!.structure,
      finishers,
      'consolation',
      state.baseline!.structureOptions,
    );
    return {
      division,
      size: entries.filter((e) => e.assignedDivision === division).length,
      poolCount: pools.length,
      pools,
      consolation:
        state.baseline!.structure !== 'round_robin' && ordered && consolation.length
          ? seedPoolFinishers(consolation)
          : null,
      championship:
        state.baseline!.structure !== 'round_robin' && ordered
          ? buildFormatFinals(
              state.baseline!.structure,
              finishers,
              'main',
              state.baseline!.structureOptions,
            ).map((q) => ({
              playerId: q.playerId,
              name: entries.find((e) => e.playerId === q.playerId)!.publicName,
              label: q.label,
            }))
          : [],
    };
  });
  const event = await eventView(db, state);
  const publishedRows = state.publication?.tournamentIds.length
    ? await db
        .select()
        .from(tournaments)
        .where(inArray(tournaments.id, state.publication.tournamentIds))
    : [];
  return {
    ...draft,
    entries,
    divisions,
    plan: { ...draft.plan, status: event.plan.status, softLockedAt: event.plan.softLockedAt },
    brackets: draft.brackets.map((b) => {
      const published = event.brackets.find(
        (p) => p.division === b.division && p.stage === b.stage,
      );
      return {
        ...b,
        challongeSlug: published?.slug ?? null,
        tournamentId: publishedRows.find((t) => t.challongeSlug === published?.slug)?.id ?? null,
      };
    }),
  };
}
