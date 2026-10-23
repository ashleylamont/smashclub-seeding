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

/** Each bracket keeps its own rounds; loser rounds contract after every pair. */
export function projectionLaneLayout(matches: ProjectedMatch[], lane: ProjectionLane) {
  const round = (match: ProjectedMatch) =>
    lane === 'finals' ? (match.bracketLane === 'reset' ? 2 : 1) : (match.bracketRound ?? 1);
  const nodes = matches
    .toSorted((a, b) => round(a) - round(b) || a.slot - b.slot)
    .map((match) => {
      const column = round(match) - 1;
      const power = lane === 'finals' ? 0 : lane === 'losers' ? Math.floor(column / 2) : column;
      const row = match.slot * 2 ** power + (2 ** power - 1) / 2;
      return {
        match,
        column,
        x: column * bracketCard.column + 12,
        y: bracketCard.top + row * bracketCard.row,
      };
    });
  const byId = new Map(nodes.map((node) => [node.match.id, node]));
  const edges = nodes.flatMap((node) =>
    node.match.feeds.flatMap((feed) => {
      const parent = byId.get(feed.matchId);
      if (!parent) return []; // Cross-bracket drops are named in the destination card.
      const x = parent.x + bracketCard.width;
      const y = parent.y + (feed.outcome === 'loser' ? 59 : 39);
      return [
        {
          from: parent.match.id,
          to: node.match.id,
          side: feed.side,
          outcome: feed.outcome,
          path: `M${x},${y} H${x + 18} V${node.y + (feed.side === 0 ? 39 : 59)} H${node.x}`,
        },
      ];
    }),
  );
  const columns = Math.max(1, ...nodes.map((node) => node.column + 1));
  return {
    nodes,
    edges,
    width: columns * bracketCard.column,
    height: Math.max(
      bracketCard.top + bracketCard.height + 12,
      ...nodes.map((n) => n.y + bracketCard.height + 12),
    ),
    rounds: Array.from({ length: columns }, (_, i) => ({
      x: i * bracketCard.column + 12,
      label: lane === 'finals' ? (i === 0 ? 'Grand final' : 'Reset · if needed') : `Round ${i + 1}`,
    })),
  };
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
