import type { LiveMatch } from './eventDisplay';
import { qualificationSummary, qualifierLabel } from './qualification';

type PresentedMatch = Pick<
  LiveMatch,
  | 'status'
  | 'outcome'
  | 'winnerId'
  | 'player1Id'
  | 'player2Id'
  | 'player1Name'
  | 'player2Name'
  | 'score1'
  | 'score2'
  | 'blockedReason'
  | 'player1Qualifier'
  | 'player2Qualifier'
  | 'qualificationBlocks'
>;

/** A missing entrant is unresolved unless the recorded result explicitly says bye. */
export function matchPresentation(match: PresentedMatch) {
  const complete = match.status === 'complete';
  const first = match.winnerId && match.winnerId === match.player1Id;
  const winner = (first ? match.player1Name : match.player2Name) || 'Player';
  const loser = (first ? match.player2Name : match.player1Name) || 'Opponent';
  const kind =
    complete && match.outcome === 'bye'
      ? 'bye'
      : complete && match.outcome === 'forfeit'
        ? 'forfeit'
        : (complete && !match.winnerId) ||
            match.blockedReason ===
              'Both players withdrawn: no contest; no winner or score recorded'
          ? 'no-contest'
          : !complete && (!match.player1Id || !match.player2Id)
            ? 'pending'
            : complete
              ? 'played'
              : 'scheduled';
  const title =
    kind === 'bye'
      ? `${winner} · Bye`
      : kind === 'pending'
        ? `${(match.player1Id ? match.player1Name : match.player2Id ? match.player2Name : null) || 'Match'} · Awaiting opponent`
        : `${match.player1Name || 'Player'} vs ${match.player2Name || 'Opponent'}`;
  const status =
    kind === 'bye'
      ? 'Bye'
      : kind === 'forfeit'
        ? 'Forfeit'
        : kind === 'no-contest'
          ? 'No contest'
          : kind === 'pending'
            ? 'Awaiting opponent'
            : complete
              ? 'Final result'
              : null;
  const result =
    kind === 'bye'
      ? `${winner} advanced automatically.`
      : kind === 'forfeit'
        ? `${winner} advances · ${loser} forfeits.`
        : kind === 'no-contest'
          ? 'No contest. No winner or score recorded.'
          : kind === 'pending'
            ? qualificationSummary(match)
            : null;
  return {
    kind,
    title,
    status,
    result,
    showScores: kind === 'played' || kind === 'scheduled',
    canReport:
      Boolean(match.player1Id && match.player2Id) &&
      (kind === 'scheduled'
        ? match.status === 'ready' || match.status === 'playing'
        : kind === 'played' && match.outcome === 'played'),
  };
}

/** Native snapshots may name an absent slot "TBD"; identity decides whether it is an entrant. */
export function matchParticipantName(match: PresentedMatch, side: 0 | 1) {
  const id = side === 0 ? match.player1Id : match.player2Id;
  if (id) return (side === 0 ? match.player1Name : match.player2Name) || 'Player';
  const { kind } = matchPresentation(match);
  const qualifier = side === 0 ? match.player1Qualifier : match.player2Qualifier;
  if (kind === 'pending' && qualifier) return qualifierLabel(qualifier);
  return kind === 'bye' ? 'Bye' : kind === 'pending' ? 'Awaiting opponent' : 'No entrant';
}

/** Only expose a later pairing once the authoritative snapshot places the winner in it. */
export function nextMeaningfulMatch(matches: readonly LiveMatch[], match: LiveMatch) {
  if (matchPresentation(match).kind !== 'bye' || !match.winnerId) return undefined;
  const direct = (candidate: LiveMatch) =>
    candidate.parent1MatchId === match.id || candidate.parent2MatchId === match.id;
  return matches
    .filter(
      (candidate) =>
        candidate.id !== match.id &&
        ['ready', 'playing', 'blocked'].includes(candidate.status) &&
        matchPresentation(candidate).kind !== 'no-contest' &&
        (candidate.player1Id === match.winnerId || candidate.player2Id === match.winnerId),
    )
    .sort(
      (a, b) =>
        Number(direct(b)) - Number(direct(a)) || (a.nativeRound ?? 0) - (b.nativeRound ?? 0),
    )[0];
}
