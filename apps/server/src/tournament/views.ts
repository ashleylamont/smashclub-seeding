import { isGeneratedQualificationWait } from './qualifiers';
import { legacyQualifierSlots } from './legacyFinalQualifiers';
import { projectMatchLabels } from './matchNames';
import {
  canReviewFrozenPoolResult,
  poolOrderRevisionToken,
  poolOrderStatus,
  poolPlacementSource,
} from './poolOrders';
import {
  eventPoolOrderViews,
  hasFixedLegacyFinals,
  worksheetOrderLock,
  type PoolOrderView,
} from './poolOrderViews';
import {
  dispatchAvailability,
  dispatchContext,
  isReserved,
  ordinaryUsage,
  publicSettings,
  sharedDispatch,
} from './dispatch';
import {
  eliminationStandings,
  buildFormatFinals,
  seedPoolFinishers,
  poolLabel,
} from '@smashclub/tournament-formats';
import {
  available,
  eventMemberViews,
  livePairNameRevision,
  memberIds,
  publicEntrantNames,
} from './entrants';
import { asc, inArray } from 'drizzle-orm';
import { players, playerCharacters, tournaments, type Db, type eventMatches } from '@smashclub/db';
import { publicPlayerName, type SetCharacterPick } from '@smashclub/shared';
import type { ResultGraphicIdentity } from '../events/participantNames';
import { buildStationQueues } from '../event-operations/queue';
import { matchAvailability, stationAvailability } from '../event-operations/availability';
import type { snapshot as sqlSnapshot } from '../event-operations/service';
import { getPlan as sqlPlan, type PlanView } from '../event-planner/plans';
import { resolved } from './facts';
import { supersededPlayedSetViews } from './resultEvidence';
import { hasCurrentPendingScoreReview } from './scoreReview';
import { pendingStrengthFinals } from './strengthFinals';
import type { Match, QualifierSlot, TournamentState } from './schemas';
import { nativeCharacterEvidence } from '../players/nativeCharacterEvidence';
import { leadingCharacters } from '../players/characterEvidence';

type SqlSnapshot = Awaited<ReturnType<typeof sqlSnapshot>>;
type MatchViewFields = Pick<
  Match,
  'player1Qualifier' | 'player2Qualifier' | 'qualificationBlocks'
> & { labelFromStructure?: true };
export type EventSnapshot = Omit<
  SqlSnapshot,
  'placements' | 'matches' | 'nativeBrackets' | 'publicCode' | 'twitchBroadcast'
> & {
  publicCode?: number;
  memberNames?: Record<string, string>;
  charactersPlayed?: Record<string, SetCharacterPick[]>;
  broadcastSides?: TournamentState['broadcastSides'];
  supersededPlayedSets?: ReturnType<typeof supersededPlayedSetViews>;
  matches: (SqlSnapshot['matches'][number] &
    MatchViewFields & { reviewPoolGames?: true; qualificationWait?: true })[];
  nativeBrackets: (SqlSnapshot['nativeBrackets'][number] & { qualifierSlots?: QualifierSlot[] })[];
  pendingFinals?: ReturnType<typeof pendingStrengthFinals>;
  placements: (Omit<SqlSnapshot['placements'][number], 'source'> & {
    source: 'manual' | 'challonge' | 'automatic' | 'retained';
  })[];
  poolOrders?: PoolOrderView[];
};
export function matchRows(state: TournamentState): (typeof eventMatches.$inferSelect &
  MatchViewFields & {
    parent1Outcome?: 'winner' | 'loser';
    parent2Outcome?: 'winner' | 'loser';
    bracketLane?: string;
    bracketRound?: number;
    called: boolean;
    callLocation: string | null;
    player1MemberIds?: string[];
    player2MemberIds?: string[];
  })[] {
  const labels = projectMatchLabels(state);
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
      ...labels.get(m.id),
      player1Id: m.player1Id,
      ...(m.player1Qualifier ? { player1Qualifier: m.player1Qualifier } : {}),
      ...(m.player2Qualifier ? { player2Qualifier: m.player2Qualifier } : {}),
      ...(m.qualificationBlocks ? { qualificationBlocks: m.qualificationBlocks } : {}),
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
      stationId: sharedDispatch(state) && !isReserved(state, m.stationId) ? null : m.stationId,
      called: sharedDispatch(state) && m.status === 'playing' && !m.started,
      callLocation: m.status === 'playing' ? (m.callLocation ?? null) : null,
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
  return state.brackets.map(({ strengthSeeding: _seedEvidence, ...b }) => {
    const rounds = state.matches.filter((m) => m.bracketId === b.id);
    const roundRobin = state.baseline!.structure === 'round_robin';
    const order = roundRobin ? state.pools[0]?.order : null;
    const outcome = eliminationStandings(
      b.entrantIds,
      rounds,
      state.baseline!.structure === 'double_elimination',
    );
    const importedSlots = legacyQualifierSlots(state, rounds);
    const qualifierSlots = b.qualifierSlots ?? (importedSlots.length ? importedSlots : undefined);
    const qualificationPending = qualifierSlots?.some((source) => source.status !== 'resolved');
    const complete = roundRobin
      ? Boolean(order && state.matches.every(resolved))
      : outcome.complete && !qualificationPending;
    const winnerId = complete ? (roundRobin ? (order?.[0] ?? null) : outcome.winnerId) : null;
    const standings =
      roundRobin && complete
        ? (order ?? []).map((playerId, i) => ({ playerId, place: i + 1 }))
        : qualificationPending
          ? []
          : outcome.standings;
    return {
      ...b,
      ...(qualifierSlots ? { qualifierSlots } : {}),
      eventPlanId: state.baseline!.planId,
      createdAt: new Date(state.baseline!.capturedAt),
      complete,
      winnerId,
      standings: standings.sort((a, b) => a.place - b.place),
    };
  });
}
function publishedBracketScope(slug: string) {
  return {
    division: slug.includes('_upper_') ? ('upper' as const) : ('lower' as const),
    stage: slug.includes('_main') ? ('main' as const) : ('consolation' as const),
  };
}

function livePlanFields(state: TournamentState) {
  const status =
    state.lifecycle === 'finalized'
      ? 'complete'
      : state.lifecycle === 'cancelled'
        ? 'cancelled'
        : 'underway';
  return { status, softLockedAt: new Date(state.baseline!.capturedAt).toISOString() } as const;
}

export async function eventView(
  db: Db,
  state: TournamentState,
  privateView = false,
): Promise<EventSnapshot> {
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
  const placedIds = new Set(state.pools.flatMap(({ order }) => order ?? []));
  const rows = matchRows(state);
  const picks = await nativeCharacterEvidence(db, state);
  const eventCharacters = leadingCharacters(picks.values());
  const reviewableMatches = new Set<string>();
  const qualificationWaits = new Set<string>();
  if (privateView) {
    const reviewablePools = new Set(
      state.pools.filter((pool) => canReviewFrozenPoolResult(state, pool)).map(({ id }) => id),
    );
    for (const match of state.matches) {
      if (
        match.stage === 'group' &&
        match.status === 'complete' &&
        match.outcome === 'played' &&
        match.poolId &&
        reviewablePools.has(match.poolId)
      )
        reviewableMatches.add(match.id);
      if (isGeneratedQualificationWait(state, match)) qualificationWaits.add(match.id);
    }
  }
  const dispatch = sharedDispatch(state) ? dispatchContext(state) : undefined;
  const pendingReviewIds =
    dispatch?.pendingReports ??
    new Set(
      rows
        .filter((match) => hasCurrentPendingScoreReview(match, state.reports))
        .map((match) => match.id),
    );
  const stations = state.stations
    .filter((s) => s.enabled && (!sharedDispatch(state) || isReserved(state, s.id)))
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
    ...(state.broadcastSides ? { broadcastSides: state.broadcastSides } : {}),
    ...(state.supersededPlayedSets
      ? { supersededPlayedSets: supersededPlayedSetViews(state, names) }
      : {}),
    ...buildStationQueues(
      rows,
      sharedDispatch(state) ? [] : stations,
      poolSchedules,
      state.entrants.filter((e) => !available(e)).map((e) => e.playerId),
      open,
      pendingReviewIds,
    ),
    sharedDispatch: sharedDispatch(state)
      ? {
          capacity: state.settings.capacity,
          active: ordinaryUsage(state),
          overCapacity: Math.max(0, ordinaryUsage(state) - state.settings.capacity),
        }
      : null,
    ...(baseline.competitionFormat === 'doubles' && {
      memberNames: Object.fromEntries(ids.map((id) => [id, names.get(id) ?? 'Player'])),
    }),
    members:
      (!sharedDispatch(state) || privateView) && state.baseline?.competitionFormat === 'doubles'
        ? eventMemberViews(state.entrants, names)
        : undefined,
    nativeBrackets: bracketViews(state),
    pendingFinals: pendingStrengthFinals(state),
    plan: {
      id: planId,
      liveOwned: true,
      drawPaused: state.lifecycle === 'unlocked',
      name: baseline.name,
      eventDate: new Date(baseline.eventDate).toISOString(),
      ...livePlanFields(state),
      bracketMode: 'native',
      competitionFormat: baseline.competitionFormat ?? 'singles',
      structure: baseline.structure ?? 'dual_division',
      structureOptions: baseline.structureOptions,
      historicalResultsSlug: null,
      resultsSlug:
        historical.find(
          (t) =>
            (t.raw as { eventPlanId?: string; division?: string })?.eventPlanId === planId &&
            t.challongeSlug.includes('_upper_main'),
        )?.challongeSlug ?? null,
    },
    brackets: historical.map((t) => ({
      ...publishedBracketScope(t.challongeSlug),
      slug: t.challongeSlug,
    })),
    settings: publicSettings(state),
    ...(picks.size && { charactersPlayed: Object.fromEntries(picks) }),
    matches: rows.map((m) => ({
      ...m,
      ...(reviewableMatches.has(m.id) ? { reviewPoolGames: true as const } : {}),
      ...(qualificationWaits.has(m.id) ? { qualificationWait: true as const } : {}),
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
        const native = state.matches.find((row) => row.id === m.id)!;
        if (sharedDispatch(state)) {
          if (privateView) return dispatchAvailability(state, native, dispatch);
          return {
            canStart: false,
            eligibleStationIds: [],
            reasons:
              m.status === 'ready'
                ? [{ code: 'awaiting_call', message: 'An organiser will call this match.' }]
                : [],
          };
        }
        const value = matchAvailability(m, rows, stations, poolSchedules, false, open);
        if (native.qualificationBlocks?.length) {
          value.canStart = false;
          value.reasons.push({
            code: 'qualification_pending',
            message: native.blockedReason ?? 'Resolve the relevant pool qualification first.',
          });
        }
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
      ...(placedIds.has(e.playerId) && {
        graphic: {
          teamName: e.teamName ?? null,
          members: memberIds(e).map((id) => ({
            name: names.get(id) ?? 'Player',
            character:
              eventCharacters.get(id)?.character ??
              characters.find((row) => row.playerId === id)?.characterSlug ??
              null,
          })),
        } satisfies ResultGraphicIdentity,
      }),
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
    poolOrders: eventPoolOrderViews(state, privateView),
    placements: state.pools.flatMap((p) =>
      (p.order ?? []).map((playerId, i) => ({
        id: `${p.id}:${playerId}`,
        eventPlanId: planId,
        division: p.division,
        poolIndex: p.index,
        playerId,
        place: i + 1,
        source: poolPlacementSource(state, p),
        createdAt: new Date(baseline.capturedAt),
        updatedAt: new Date(baseline.capturedAt),
      })),
    ),
  };
}

export async function planView(
  db: Db,
  state: TournamentState,
  revisionEvidence?: 'compact',
): Promise<PlanView> {
  const draft = (await sqlPlan(db, state.baseline!.planId))!;
  const profiles = new Map((await db.select().from(players)).map((p) => [p.id, p]));
  const originalEntrantIds = new Set(state.baseline!.entrants.map(({ id }) => id));
  const entries = state.entrants.map((e, i) => {
    const old = draft.entries.find((old) => old.id === e.id);
    const p = profiles.get(e.playerId);
    const pairProfiles = e.memberPlayerIds
      ?.map((id) => profiles.get(id))
      .filter((p) => p !== undefined);
    const pairName = pairProfiles?.map(publicPlayerName).join(' / ');
    const latePair = e.memberPlayerIds && !originalEntrantIds.has(e.id);
    const noFrozenPairRating = e.memberSubstituted || latePair;
    return {
      ...old,
      id: e.id,
      sourceLineNumber: old?.sourceLineNumber ?? i + 1,
      rawInput: old?.rawInput ?? e.name,
      cleanedName: old?.cleanedName ?? e.name,
      companyCode: old?.companyCode ?? null,
      playerId: e.playerId,
      playerName: p?.canonicalName ?? e.name,
      ...(e.memberPlayerIds && {
        primaryPlayerId: e.memberPlayerIds[0] ?? null,
        partnerPlayerId: e.memberPlayerIds[1] ?? null,
        memberPlayerIds: e.memberPlayerIds,
        memberNames: pairProfiles?.map((profile) => profile.canonicalName),
        teamName: e.teamName,
        pairNameRevision:
          e.memberPlayerIds.length === 2 &&
          (state.lifecycle === 'locked' || state.lifecycle === 'unlocked')
            ? livePairNameRevision(e)
            : undefined,
        snapshotMean: e.snapshotMean,
        snapshotSd: e.snapshotSd,
      }),
      ...(e.memberSubstituted && { memberSubstituted: true as const }),
      ...(latePair && { latePair: true as const }),
      ...(noFrozenPairRating && {
        pairRating: undefined,
        currentMean: undefined,
        currentSd: undefined,
      }),
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
      currentRank: noFrozenPairRating ? null : (old?.currentRank ?? null),
      currentScore: noFrozenPairRating ? null : (old?.currentScore ?? null),
      lastPlayedDate: noFrozenPairRating ? null : (old?.lastPlayedDate ?? null),
      withdrawn: e.availability === 'withdrawn',
      candidates: old?.candidates ?? [],
    };
  });
  const divisions = (
    state.baseline!.structure && state.baseline!.structure !== 'dual_division'
      ? (['upper'] as const)
      : (['upper', 'lower'] as const)
  ).map((division) => {
    const fixedLegacyFinals = hasFixedLegacyFinals(state, division);
    const divisionPools = state.pools.filter((p) => p.division === division);
    const pools = divisionPools.map((p) => {
      const orderLockedReason = worksheetOrderLock(state, p, fixedLegacyFinals);
      const matches = state.matches.filter((m) => m.poolId === p.id);
      return {
        poolIndex: p.index,
        label: poolLabel(p.index),
        placementRevision: String(p.revision),
        qualifierRoster: p.qualifierRoster,
        rulingOptions: p.qualifierRoster
          ? p.qualifierDecision?.groups.flatMap((group) => group.map(() => group))
          : undefined,
        orderLockedReason,
        orderStatus:
          fixedLegacyFinals && orderLockedReason && !p.order
            ? undefined
            : poolOrderStatus(state, p),
        ...(revisionEvidence !== 'compact' && {
          matchRevisions: matches.map(({ id, revision }) => ({ id, revision })),
        }),
        matchRevisionToken: poolOrderRevisionToken(
          p,
          Object.fromEntries(matches.map(({ id, revision }) => [id, revision])),
        ),
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
      };
    });
    const canPreview =
      !fixedLegacyFinals &&
      state.baseline!.structure !== 'round_robin' &&
      divisionPools.every((p) => p.order);
    const finishers = canPreview
      ? pools.flatMap((p) =>
          p.members
            .filter((m) =>
              p.qualifierRoster ? p.qualifierRoster.includes(m.playerId) : !m.withdrawn,
            )
            .sort((a, b) => a.place! - b.place!)
            .map((m, i) => ({ playerId: m.playerId, poolIndex: p.poolIndex, place: i + 1 })),
        )
      : [];
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
      ...(fixedLegacyFinals ? { fixedLegacyFinals } : {}),
      consolation: consolation.length ? seedPoolFinishers(consolation) : null,
      championship: buildFormatFinals(
        state.baseline!.structure,
        finishers,
        'main',
        state.baseline!.structureOptions,
      ).map((q) => ({
        playerId: q.playerId,
        name: entries.find((e) => e.playerId === q.playerId)!.publicName,
        label: q.label,
      })),
    };
  });
  const publishedRows = state.publication?.tournamentIds.length
    ? await db
        .select({ id: tournaments.id, slug: tournaments.challongeSlug })
        .from(tournaments)
        .where(inArray(tournaments.id, state.publication.tournamentIds))
    : [];
  const publishedBrackets = publishedRows.map((row) => ({
    ...row,
    ...publishedBracketScope(row.slug),
  }));
  return {
    ...draft,
    entries,
    divisions,
    plan: { ...draft.plan, ...livePlanFields(state) },
    brackets: draft.brackets.map((b) => {
      const published = publishedBrackets.find(
        (p) => p.division === b.division && p.stage === b.stage,
      );
      return {
        ...b,
        challongeSlug: published?.slug ?? null,
        tournamentId: published?.id ?? null,
      };
    }),
  };
}
