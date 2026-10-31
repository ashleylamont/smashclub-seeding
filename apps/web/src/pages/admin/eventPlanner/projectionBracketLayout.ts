import { eliminationLaneLayout } from '../../../lib/eliminationLayout';
import { duration, projectedTime, type ProjectedMatch } from './projectionView';

export type ProjectionLane = 'winners' | 'losers' | 'finals';
export const bracketCard = { width: 224, height: 76, column: 264, row: 96, top: 40 };

export function projectionMatchName(match: ProjectedMatch): string {
  switch (match.bracketLane) {
    case 'winners':
      return `W${match.bracketRound}.${match.slot + 1}`;
    case 'losers':
      return `L${match.bracketRound}.${match.slot + 1}`;
    case 'final':
      return 'Grand final';
    case 'reset':
      return 'Reset final';
    default:
      return match.id;
  }
}

export function projectionPairing(match: ProjectedMatch, byId: Map<string, ProjectedMatch>) {
  return match.sides.map((label, side) => {
    if (label === 'Bye') return label;
    const feed = match.feeds.find((f) => f.side === side);
    const parent = feed && byId.get(feed.matchId);
    return parent
      ? `${feed.outcome === 'loser' ? 'Loser' : 'Winner'} ${projectionMatchName(parent)}`
      : match.bracketLane && label.startsWith('O seed ')
        ? `Seed ${label.slice('O seed '.length)}`
        : label;
  });
}

/** Planning and the public draw share the same lane geometry and feed routing. */
export function projectionLaneLayout(matches: ProjectedMatch[], lane: ProjectionLane) {
  return eliminationLaneLayout(
    matches,
    lane,
    {
      id: (match) => match.id,
      round: (match) =>
        lane === 'finals' ? (match.bracketLane === 'reset' ? 2 : 1) : (match.bracketRound ?? 1),
      slot: (match) => match.slot,
      feeds: (match) => match.feeds,
    },
    bracketCard,
  );
}

export function projectionWindow(projection: { matches: ProjectedMatch[]; totalMinutes: number }) {
  const withoutReset = projection.matches.reduce(
    (end, match) => Math.max(end, match.conditional ? 0 : match.endMinute),
    0,
  );
  return { withoutReset, withReset: projection.totalMinutes };
}

export function projectionDuration(projection: {
  matches: ProjectedMatch[];
  totalMinutes: number;
}) {
  const window = projectionWindow(projection);
  return window.withoutReset === window.withReset
    ? duration(window.withReset)
    : `${duration(window.withoutReset)}–${duration(window.withReset)}`;
}

export function projectionFinish(
  projection: { matches: ProjectedMatch[]; totalMinutes: number },
  start: string,
) {
  const window = projectionWindow(projection);
  return window.withoutReset === window.withReset
    ? projectedTime(start, window.withReset)
    : `${projectedTime(start, window.withoutReset)}–${projectedTime(start, window.withReset)}`;
}

export function projectionColor(match: ProjectedMatch) {
  return match.bracketLane ? `projection-de-${match.bracketLane}` : `projection-${match.stage}`;
}
