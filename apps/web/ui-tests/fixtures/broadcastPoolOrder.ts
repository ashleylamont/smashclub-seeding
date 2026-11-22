import type { LiveMatch } from '../../src/lib/eventDisplay';
import type { mockEvent } from '../fixtures';

type Snapshot = Awaited<ReturnType<typeof mockEvent>>['snapshot'];

/** Recreate the audit's three-way 2–1 tie with unequal game differentials. */
export function broadcastPoolOrderFixture(snapshot: Snapshot) {
  const names = [
    'Harbour Lantern Collector',
    'Parallax',
    'Sunset Observatory Recording Desk',
    'Canary',
  ];
  const ids = ['harbour', 'parallax', 'sunset', 'canary'];
  const base = snapshot.matches.find((match) => match.stage === 'group')!;
  const lowerMatches: LiveMatch[] = [
    [0, 2, 0],
    [1, 0, 1],
    [2, 1, 1],
    [0, 3, 0],
    [1, 3, 0],
    [2, 3, 0],
  ].map(([winner, loser, score], index) => ({
    ...base,
    id: `audit-pool-set-${index}`,
    division: 'lower',
    poolIndex: 0,
    player1Id: ids[winner!]!,
    player1Name: names[winner!]!,
    player2Id: ids[loser!]!,
    player2Name: names[loser!]!,
    winnerId: ids[winner!]!,
    score1: 2,
    score2: score!,
    status: 'complete',
    outcome: 'played',
    resultUpdatedAt: null,
  }));
  const order = { poolId: 'lower-a', division: 'lower', poolIndex: 0 };
  const upper = snapshot.matches
    .filter(
      ({ stage, division, poolIndex }) =>
        stage === 'group' && division === 'upper' && poolIndex === 0,
    )
    .map((match) => ({ ...match, resultUpdatedAt: null }));
  const finalists = (confirmed: boolean) =>
    [1, 2, 3, 4].map((place) => ({
      ...order,
      place,
      status: confirmed || place === 4 ? 'resolved' : 'pending',
      entrantId: confirmed || place === 4 ? ids[[2, 1, 0, 3][place - 1]!]! : null,
    }));
  const source = {
    ...snapshot,
    matches: [...lowerMatches, ...upper],
    entrants: [...snapshot.entrants, ...ids.map((id, index) => ({ id, name: names[index]! }))],
    poolOrders: [
      { ...order, status: 'partial', reason: 'Confirm a ruling for the tied places.' },
      {
        ...order,
        poolId: 'upper-a',
        division: 'upper',
        status: 'incomplete',
        reason: 'Complete the pool matches.',
      },
    ],
    placements: [],
    pendingFinals: [
      { division: 'lower', stage: 'main', slots: finalists(false).slice(0, 2) },
      { division: 'lower', stage: 'consolation', slots: finalists(false).slice(2) },
    ],
  };
  return { source, names, ids, finalists, order };
}
