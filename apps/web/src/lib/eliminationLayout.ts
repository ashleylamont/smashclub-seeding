export type EliminationLane = 'winners' | 'losers' | 'finals';
export type BracketGeometry = {
  width: number;
  height: number;
  column: number;
  row: number;
  top: number;
  side1?: number;
  side2?: number;
};
export type BracketFeed = { matchId: string; side: 0 | 1; outcome: 'winner' | 'loser' };

/** Explicit round/slot positions only. Cross-lane feeds remain named on the card. */
export function eliminationLaneLayout<T>(
  matches: readonly T[],
  lane: EliminationLane,
  read: {
    id: (match: T) => string;
    round: (match: T) => number;
    slot: (match: T) => number;
    feeds: (match: T) => BracketFeed[];
    sourcePort?: (match: T, outcome: BracketFeed['outcome']) => number;
    targetPort?: (match: T, side: 0 | 1) => number;
  },
  card: BracketGeometry,
) {
  const nodes = matches
    .toSorted(
      (a, b) =>
        read.round(a) - read.round(b) ||
        read.slot(a) - read.slot(b) ||
        read.id(a).localeCompare(read.id(b)),
    )
    .map((match) => {
      const column = Math.max(0, read.round(match) - 1);
      const power = lane === 'finals' ? 0 : lane === 'losers' ? Math.floor(column / 2) : column;
      const row = read.slot(match) * 2 ** power + (2 ** power - 1) / 2;
      return { match, column, x: column * card.column + 12, y: card.top + row * card.row };
    });
  const byId = new Map(nodes.map((node) => [read.id(node.match), node]));
  const sideY = (side: number) => (side === 0 ? (card.side1 ?? 39) : (card.side2 ?? 59));
  const edges = nodes.flatMap((node) =>
    read.feeds(node.match).flatMap((feed) => {
      const parent = byId.get(feed.matchId);
      // Never invent a connection or route a line backwards through cards.
      if (!parent || parent.column >= node.column) return [];
      const x = parent.x + card.width;
      const y =
        parent.y +
        (read.sourcePort?.(parent.match, feed.outcome) ?? sideY(feed.outcome === 'loser' ? 1 : 0));
      const endY = node.y + (read.targetPort?.(node.match, feed.side) ?? sideY(feed.side));
      return [
        {
          from: read.id(parent.match),
          to: read.id(node.match),
          side: feed.side,
          outcome: feed.outcome,
          path: `M${x},${y} H${x + 18} V${endY} H${node.x}`,
          start: { x, y },
          end: { x: node.x, y: endY },
        },
      ];
    }),
  );
  const columns = Math.max(1, ...nodes.map((node) => node.column + 1));
  return {
    nodes,
    edges,
    width: columns * card.column,
    height: Math.max(
      card.top + card.height + 12,
      ...nodes.map((node) => node.y + card.height + 12),
    ),
    rounds: Array.from({ length: columns }, (_, i) => ({
      x: i * card.column + 12,
      label: lane === 'finals' ? (i === 0 ? 'Grand final' : 'Reset · if needed') : `Round ${i + 1}`,
    })),
  };
}
