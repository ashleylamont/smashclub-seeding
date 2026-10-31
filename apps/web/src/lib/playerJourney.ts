import type { NativeBracketView } from '../components/EventNightBoard';
import { includesPlayer, matchStation, matchStatus, sortPlayerMatches } from './playerMatchView';
import { playerBracketPath, playerHubView } from './playerHubView';
import type { PoolFlowData, PoolFlowMatch } from './poolFlow';
import { qualificationSummary } from './qualification';

type JourneyData = Omit<PoolFlowData, 'plan' | 'matches'> & {
  plan: PoolFlowData['plan'] & { structure?: string };
  nativeBrackets?: NativeBracketView[];
  entrants?: { id: string; name: string; memberPlayerIds?: string[] }[];
  withdrawals?: { playerId: string }[];
  matches: (PoolFlowMatch & { pendingDisputeCount?: number })[];
};
export type PlayerJourney = {
  state:
    | 'closed'
    | 'withdrawn'
    | 'active'
    | 'awaiting_opponent'
    | 'held'
    | 'qualification'
    | 'bracket_finished'
    | 'winner'
    | 'pool_finished'
    | 'awaiting_stage'
    | 'review';
  summary: string;
  consequences: { outcome: 'Win' | 'Loss' | 'Conditional'; label: string }[];
};

/** Only published feeder edges describe a consequence; a reset is always conditional. */
export function playerConsequences(matches: readonly PoolFlowMatch[], current: PoolFlowMatch) {
  if (current.stage === 'group' || current.status === 'complete') return [];
  const destinations = matches.flatMap((match) =>
    ([1, 2] as const).flatMap((side) => {
      const parent = side === 1 ? match.parent1MatchId : match.parent2MatchId;
      if (parent !== current.id || match.status === 'complete') return [];
      const outcome = (side === 1 ? match.parent1Outcome : match.parent2Outcome) ?? 'winner';
      return [
        {
          outcome:
            match.bracketLane === 'reset'
              ? ('Conditional' as const)
              : outcome === 'winner'
                ? ('Win' as const)
                : ('Loss' as const),
          label: match.label,
        },
      ];
    }),
  );
  return [...new Map(destinations.map((item) => [`${item.outcome}:${item.label}`, item])).values()];
}

/** Describe a personal run from actual participants/results, never from predicted seeds. */
export function playerJourney(data: JourneyData, player: string): PlayerJourney {
  const result = (
    state: PlayerJourney['state'],
    summary: string,
    consequences: PlayerJourney['consequences'] = [],
  ): PlayerJourney => ({ state, summary, consequences });
  if (['complete', 'cancelled'].includes(data.plan.status))
    return result(
      'closed',
      'This event is closed. Your recorded results and standings remain below.',
    );
  const board = playerHubView(data, player);
  if (data.withdrawals?.some((row) => board.identities.has(row.playerId)))
    return result(
      'withdrawn',
      'You are withdrawn. Your recorded results are retained; ask a TO if you are returning.',
    );
  const own = sortPlayerMatches(
    data,
    data.matches.filter((match) => includesPlayer(match, player)),
  );
  const open = own.filter((match) => match.status !== 'complete');
  const current =
    open.find((match) => match.status === 'playing') ??
    open.find((match) => match.status === 'ready' && match.player1Id && match.player2Id) ??
    open[0];
  if (current) {
    const consequences = playerConsequences(data.matches, current);
    if (!current.player1Id || !current.player2Id)
      return result(
        'awaiting_opponent',
        qualificationSummary(current) ??
          `Waiting for a confirmed pairing · ${current.label}. Follow the published draw below.`,
        consequences,
      );
    if (current.status === 'blocked')
      return result(
        'held',
        qualificationSummary(current) ??
          `${current.label} is waiting for an earlier result or a TO decision.`,
        consequences,
      );
    const location = matchStation(data, current).name;
    return result(
      'active',
      `${matchStatus(data, current)} · ${current.label}${location ? ` · ${location}` : ''}`,
      consequences,
    );
  }
  const reviewed = own.some(
    (match) =>
      (match.pendingDisputeCount ?? 0) > 0 ||
      match.qualificationBlocks?.some((source) => source.status === 'review_pending'),
  );
  if (reviewed)
    return result(
      'review',
      'Your recorded results are under review. The organisers will confirm any effect on your progression.',
    );
  if (board.pendingBrackets.length)
    return result(
      'qualification',
      board.pendingBrackets.some((bracket) =>
        bracket.qualifierSlots?.some(
          (slot) =>
            slot.status === 'review_pending' &&
            slot.eligibleEntrantIds.some((id) => board.identities.has(id)),
        ),
      )
        ? 'Your pool qualification is under review. Follow the reserved pool places in the draw below.'
        : 'Your pool sets are recorded. Waiting for the remaining pool results and confirmed qualification.',
    );
  const won = board.assignedBrackets.find(
    (bracket) => bracket.complete && bracket.winnerId && board.identities.has(bracket.winnerId),
  );
  if (won)
    return result(
      'winner',
      `You won the ${won.stage === 'main' ? 'championship' : 'consolation'} bracket. Your recorded results and standings remain below.`,
    );
  const assigned = new Set(board.assignedBrackets.map((bracket) => bracket.id));
  const path = playerBracketPath(
    data.matches.filter((match) =>
      Boolean(match.nativeBracketId && assigned.has(match.nativeBracketId)),
    ),
    player,
  );
  const waiting = path.find((match) => match.status !== 'complete');
  if (waiting)
    return result(
      'awaiting_opponent',
      `Waiting for a confirmed pairing · ${waiting.label}. Follow the published draw below.`,
    );
  const bracketResults = own.filter(
    (match) =>
      match.status === 'complete' && match.nativeBracketId && assigned.has(match.nativeBracketId),
  );
  if (board.assignedBrackets.length && board.assignedBrackets.every((bracket) => bracket.complete))
    return result(
      'bracket_finished',
      'Your published bracket run is finished. Your recorded results remain available while the event continues.',
    );
  const terminalResults = bracketResults.filter(
    (match) =>
      !bracketResults.some(
        (later) => later.parent1MatchId === match.id || later.parent2MatchId === match.id,
      ),
  );
  if (
    terminalResults.length &&
    terminalResults.every((match) => match.winnerId && !board.identities.has(match.winnerId))
  )
    return result(
      'bracket_finished',
      'Your published bracket run is finished. Your recorded results remain available while the event continues.',
    );
  const pools = own.filter((match) => match.stage === 'group');
  if (pools.length && data.plan.structure === 'round_robin')
    return result(
      'pool_finished',
      board.resolvedPools
        ? 'Your pool matches are complete. Check the recorded standings below.'
        : 'Your pool matches are complete. Other pool results are still outstanding.',
    );
  const sourceSlots = (data.nativeBrackets ?? [])
    .flatMap((bracket) => bracket.qualifierSlots ?? [])
    .filter((slot) => board.ownPools.has(`${slot.division}:${slot.poolIndex}`));
  if (
    pools.length &&
    sourceSlots.length &&
    !sourceSlots.some((slot) => slot.entrantId && board.identities.has(slot.entrantId)) &&
    (sourceSlots.every((slot) => slot.status === 'resolved') ||
      !sourceSlots.some((slot) => slot.eligibleEntrantIds.some((id) => board.identities.has(id))))
  )
    return result(
      'pool_finished',
      'Your pool matches are complete. You are outside the published finals field; ask a TO about any attendance or qualification ruling.',
    );
  return result(
    'awaiting_stage',
    own.length
      ? 'Your scheduled matches are complete. Waiting for the next published stage or confirmed standings.'
      : 'Pairings have not been published for this player.',
  );
}
