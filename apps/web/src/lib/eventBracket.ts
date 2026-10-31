import type { LiveMatch } from './eventDisplay';
import type { BracketFeed, EliminationLane } from './eliminationLayout';
import { qualifierLabel } from './qualification';

export function liveBracketFeeds(match: LiveMatch): BracketFeed[] {
  return ([0, 1] as const).flatMap((side) => {
    const id = side === 0 ? match.parent1MatchId : match.parent2MatchId;
    const outcome = (side === 0 ? match.parent1Outcome : match.parent2Outcome) ?? 'winner';
    return id ? [{ matchId: id, side, outcome }] : [];
  });
}
export function liveBracketSide(match: LiveMatch, side: 0 | 1, labels: Map<string, string>) {
  const id = side === 0 ? match.player1Id : match.player2Id;
  const name = side === 0 ? match.player1Name : match.player2Name;
  if (id) return name || 'Player';
  // A completed automatic bye has no pending feeder, even if its source is recorded.
  if (match.status === 'complete' && match.outcome === 'bye') return 'Bye';
  if (match.status === 'complete') return 'No entrant';
  const qualifier = side === 0 ? match.player1Qualifier : match.player2Qualifier;
  if (qualifier) return qualifierLabel(qualifier);
  const feed = liveBracketFeeds(match).find((item) => item.side === side);
  return feed
    ? `${feed.outcome === 'loser' ? 'Loser' : 'Winner'} of ${labels.get(feed.matchId) ?? 'previous match'}`
    : 'To be decided';
}
export function liveBracketRound(match: LiveMatch) {
  return match.bracketLane === 'reset'
    ? 2
    : match.bracketLane === 'final'
      ? 1
      : (match.bracketRound ?? match.nativeRound ?? 1);
}
export function liveBracketStatus(match: LiveMatch) {
  if (match.status === 'complete') {
    if (match.outcome === 'bye') return 'Bye';
    if (!match.winnerId) return 'No contest';
    return match.outcome === 'forfeit' ? 'Forfeit' : 'Final result';
  }
  if (match.status === 'playing') return match.called ? 'Called' : 'Playing now';
  if (match.qualificationBlocks?.some((source) => source.status === 'review_pending'))
    return 'Qualification under review';
  if (
    [match.player1Qualifier, match.player2Qualifier].some(
      (source) => source && source.status !== 'resolved',
    )
  )
    return 'Waiting for qualifiers';
  if (match.bracketLane === 'reset' && match.status === 'blocked') return 'If needed';
  return match.status === 'blocked' ? 'Waiting for feeders' : 'Upcoming';
}
export function liveBracketWinner(match: LiveMatch, id: string | null) {
  return Boolean(id && match.status === 'complete' && match.winnerId === id);
}
export function liveBracketLanes(matches: LiveMatch[]) {
  if (!matches.length) return [];
  if (!matches.some((match) => match.bracketLane))
    return [{ key: 'winners' as EliminationLane, title: '', matches }];
  return (
    [
      ['winners', 'Winners bracket'],
      ['losers', 'Losers bracket'],
      ['finals', 'Grand final and reset'],
    ] as const
  )
    .map(([key, title]) => ({
      key,
      title,
      matches: matches.filter((match) =>
        key === 'finals'
          ? match.bracketLane === 'final' || match.bracketLane === 'reset'
          : key === 'winners'
            ? !match.bracketLane || match.bracketLane === 'winners'
            : match.bracketLane === key,
      ),
    }))
    .filter((lane) => lane.matches.length);
}
