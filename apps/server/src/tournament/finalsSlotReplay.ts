import { available } from './entrants';
import { hash, requireFact, resolved, stableId } from './facts';
import { matchNames } from './matchNames';
import { automaticPoolOrder, canReviewFrozenPoolResult, poolOrderEvidence } from './poolOrders';
import { qualificationPlaces, qualifierKey } from './qualifiers';
import { appendOperatorScoreReport, winner } from './scores';
import { canUseStrengthSeeding } from './strengthFinals';
import type { CommandEnvelope, Match, TournamentState } from './schemas';

type ReplayCommand = Extract<CommandEnvelope['command'], { kind: 'replayFinalsSlotV1' }>;
type ReplayScore = Pick<ReplayCommand, 'matchId' | 'expectedRevision' | 'score1' | 'score2'>;
type QualifierChange = {
  bracketId: string;
  division: 'upper' | 'lower';
  stage: 'main' | 'consolation';
  poolId: string;
  poolIndex: number;
  place: number;
  beforeEntrantId: string | null;
  afterEntrantId: string | null;
};

function blocked(issue: string, qualifierChanges: QualifierChange[] = []) {
  return { preview: { allowed: false as const, issues: [issue], qualifierChanges }, plan: null };
}

function dependants(state: TournamentState, original: Match) {
  const affected = new Map([[original.id, original]]);
  // A match is only visited once even if both of its parent sides are affected.
  for (const id of affected.keys())
    for (const match of state.matches)
      if (match.parent1Id === id || match.parent2Id === id || match.activation?.matchId === id)
        affected.set(match.id, match);
  affected.delete(original.id);
  return [...affected.values()];
}

function reviewFinalsSlotReplay(state: TournamentState, input: ReplayScore) {
  const { matchId, expectedRevision, score1, score2 } = input;
  const source = state.matches.find(({ id }) => id === matchId);
  if (source?.revision !== expectedRevision)
    return blocked('This match changed. Reopen its score before reviewing a replay.');
  if (
    source.stage !== 'group' ||
    !resolved(source) ||
    source.outcome !== 'played' ||
    !source.player1Id ||
    !source.player2Id ||
    score1 === score2
  )
    return blocked('Review a decisive corrected result for an already-played pool set.');
  const sourceWinner = winner({ kind: 'score', ...input, outcome: 'played' }, source);
  if (sourceWinner === source.winnerId)
    return blocked('A finals replay requires a pool correction that changes the winner.');

  const pool = state.pools.find(({ id }) => id === source.poolId);
  if (!pool || !canUseStrengthSeeding(state) || !canReviewFrozenPoolResult(state, pool))
    return blocked('Replay requires a frozen automatic pool order with no scores awaiting review.');

  const corrected = { ...source, score1, score2, winnerId: sourceWinner };
  const trial = {
    ...state,
    matches: state.matches.map((match) => (match.id === source.id ? corrected : match)),
  };
  const order = automaticPoolOrder(trial, pool);
  if (!order) return blocked('The corrected results need a separate ruling for the pool order.');

  const places = qualificationPlaces(trial, { ...pool, order });
  const qualifierChanges = state.brackets.flatMap(({ id, division, stage, qualifierSlots }) =>
    (qualifierSlots ?? []).flatMap((slot) => {
      if (slot.poolId !== pool.id) return [];
      const entrant = places[slot.place - 1]?.entrantId ?? null;
      return slot.entrantId === entrant
        ? []
        : [
            {
              bracketId: id,
              division,
              stage,
              poolId: slot.poolId,
              poolIndex: slot.poolIndex,
              place: slot.place,
              beforeEntrantId: slot.entrantId,
              afterEntrantId: entrant,
            },
          ];
    }),
  );
  if (qualifierChanges.length !== 1)
    return blocked(
      qualifierChanges.length
        ? 'This correction changes more than one existing finals slot. Review each affected draw before proceeding.'
        : 'This correction does not change an existing finals slot.',
      qualifierChanges,
    );

  const change = qualifierChanges[0]!;
  const bracket = state.brackets.find(({ id }) => id === change.bracketId)!;
  const originalSides = state.matches.flatMap((match) =>
    match.bracketId === bracket.id
      ? (['player1', 'player2'] as const).flatMap((side) => {
          const qualifier = match[`${side}Qualifier`];
          return qualifier && qualifierKey(qualifier) === qualifierKey(change)
            ? [{ match, side }]
            : [];
        })
      : [],
  );
  const original = originalSides.length === 1 ? originalSides[0] : undefined;
  if (
    !original ||
    original.match.round !== 1 ||
    original.match.parent1Id ||
    original.match.parent2Id ||
    !resolved(original.match) ||
    original.match.outcome !== 'played' ||
    original.match.completedAt === null ||
    !change.beforeEntrantId ||
    original.match[`${original.side}Id`] !== change.beforeEntrantId ||
    state.supersededPlayedSets?.some((entry) => entry.replacementMatchId === original.match.id)
  )
    return blocked(
      'The changed place must feed one already-played opening set that has not been replayed.',
      qualifierChanges,
    );

  const player1Id = original.side === 'player1' ? change.afterEntrantId : original.match.player1Id;
  const player2Id = original.side === 'player2' ? change.afterEntrantId : original.match.player2Id;
  const entrants = [player1Id, player2Id].map((id) =>
    state.entrants.find((e) => e.playerId === id),
  );
  if (
    !player1Id ||
    !player2Id ||
    player1Id === player2Id ||
    entrants.some((e) => !e || !available(e))
  )
    return blocked('Both players in the replay must be available.', qualifierChanges);

  const downstream = dependants(state, original.match);
  const downstreamIds = new Set(downstream.map(({ id }) => id));
  if (
    original.match.qualificationBlocks?.length ||
    downstream.some((m) => m.qualificationBlocks?.length)
  )
    return blocked(
      'Resolve the affected finals qualification reviews before replaying this slot.',
      qualifierChanges,
    );
  if (downstream.some((m) => m.held))
    return blocked(
      'Resolve the downstream organiser hold before replaying this slot.',
      qualifierChanges,
    );
  if (downstream.some((m) => m.started || m.status === 'playing' || resolved(m)))
    return blocked(
      'A downstream pairing has already been called, started or resolved.',
      qualifierChanges,
    );
  if (
    state.reports.some(
      (r) =>
        downstreamIds.has(r.matchId) || (r.matchId === original.match.id && r.status === 'pending'),
    )
  )
    return blocked(
      'Resolve outstanding reports. A downstream pairing with report history cannot be replayed here.',
      qualifierChanges,
    );
  if (
    downstream.some(
      (m) =>
        m.bracketId !== bracket.id ||
        m.activation ||
        m.parent1Outcome === 'loser' ||
        m.parent2Outcome === 'loser',
    )
  )
    return blocked(
      'This replay requires an independent single-elimination route.',
      qualifierChanges,
    );

  const poolMatches = state.matches.filter((m) => m.poolId === pool.id);
  const reviewedMatchIds = new Set(
    [...poolMatches, original.match, ...downstream].map(({ id }) => id),
  );
  const revisionToken = hash({
    input: { matchId, expectedRevision, score1, score2 },
    pool,
    poolMatches,
    order,
    brackets: state.brackets.filter(({ division }) => division === pool.division),
    original,
    downstream,
    reports: state.reports.filter((r) => reviewedMatchIds.has(r.matchId)),
    entrants,
  });
  const labels = matchNames(state);
  const {
    id,
    score1: originalScore1,
    score2: originalScore2,
    player1Id: originalPlayer1,
    player2Id: originalPlayer2,
  } = original.match;
  const label = labels.get(id) ?? original.match.label;
  return {
    preview: {
      allowed: true as const,
      issues: [],
      qualifierChanges,
      revisionToken,
      original: {
        id,
        label,
        player1Id: originalPlayer1,
        player2Id: originalPlayer2,
        score1: originalScore1,
        score2: originalScore2,
      },
      replay: { player1Id, player2Id },
      downstream: downstream.map(({ id, label }) => ({ id, label: labels.get(id) ?? label })),
    },
    plan: {
      source,
      corrected,
      pool,
      order,
      poolMatches,
      bracket,
      change,
      original: original.match,
      downstream,
      player1Id,
      player2Id,
      label,
    },
  };
}

export function previewFinalsSlotReplay(state: TournamentState, input: ReplayScore) {
  return reviewFinalsSlotReplay(state, input).preview;
}

export function replayFinalsSlot(
  state: TournamentState,
  envelope: CommandEnvelope,
  command: ReplayCommand,
  basis: Record<string, number>,
) {
  const { plan, preview } = reviewFinalsSlotReplay(state, command);
  requireFact(
    preview.allowed && plan && preview.revisionToken === command.revisionToken,
    preview.issues[0] ?? 'Finals replay evidence changed. Review the replay again.',
  );
  const {
    source,
    corrected,
    pool,
    order,
    poolMatches,
    bracket,
    change,
    original,
    downstream,
    player1Id,
    player2Id,
    label,
  } = plan;
  for (const match of [...poolMatches, original, ...downstream]) basis[match.id] = match.revision;
  basis[pool.id] = pool.revision;
  Object.assign(source, {
    score1: corrected.score1,
    score2: corrected.score2,
    winnerId: corrected.winnerId,
    revision: source.revision + 1,
    resultCommandId: envelope.id,
    automaticFromRevision: null,
  });
  pool.order = order;
  pool.revision++;
  pool.orderDecision = {
    source: 'automatic',
    policy: 'unique_set_wins_v1',
    order,
    ...poolOrderEvidence(state, pool, envelope, poolMatches),
  };
  const slot = bracket.qualifierSlots!.find((slot) => qualifierKey(slot) === qualifierKey(change))!;
  slot.entrantId = change.afterEntrantId;
  bracket.entrantIds = bracket.qualifierSlots!.flatMap((slot) =>
    slot.entrantId ? [slot.entrantId] : [],
  );

  const replacementMatchId = stableId(`${envelope.id}:slot-replay:${original.id}`);
  state.supersededPlayedSets = [
    ...(state.supersededPlayedSets ?? []),
    { match: structuredClone(original), replacementMatchId, label, sourcePoolMatchId: source.id },
  ];
  state.matches[state.matches.indexOf(original)] = {
    ...original,
    id: replacementMatchId,
    player1Id,
    player2Id,
    status: 'ready',
    outcome: null,
    score1: null,
    score2: null,
    winnerId: null,
    stationId: null,
    revision: 0,
    started: false,
    completedAt: null,
    automaticFromRevision: null,
    resultCommandId: null,
    liveScore1: null,
    liveScore2: null,
    progressRevision: 0,
    calledAt: null,
    callLocation: null,
    readySince: envelope.at,
    held: false,
    blockedReason: null,
  };

  const affected = new Set([original.id, ...downstream.map(({ id }) => id)]);
  for (const match of downstream) {
    for (const side of [1, 2] as const) {
      const parent = `parent${side}Id` as const;
      if (!affected.has(match[parent] ?? '')) continue;
      if (match[parent] === original.id) match[parent] = replacementMatchId;
      match[`player${side}Id`] = null;
    }
    match.status = 'blocked';
    delete match.readySince;
    match.revision++;
  }
  const queue = state.settings.queueOrder;
  if (queue?.some((id) => affected.has(id))) {
    state.settings.queueOrder = queue.filter((id) => !affected.has(id));
    state.settings.queueRevision = (state.settings.queueRevision ?? 0) + 1;
  }
  return appendOperatorScoreReport(
    state,
    envelope,
    { ...command, outcome: 'played' },
    corrected.winnerId!,
  );
}
