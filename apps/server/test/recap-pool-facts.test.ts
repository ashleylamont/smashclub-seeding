import { expect, it } from 'vitest';
import { nativeDoublesPoolFacts } from '../src/recap/poolFacts';
import { playerSetScore } from '../src/events/playerSetScore';

const names = new Map(
  ['a', 'b', 'c'].map((id) => [
    id,
    { playerId: null, name: `Pair ${id.toUpperCase()}`, companyCode: null, characters: [] },
  ]),
);
const evidence: Parameters<typeof nativeDoublesPoolFacts>[0] = {
  competitionFormat: 'doubles',
  poolOrders: [{ division: 'upper', order: ['c', 'a', 'b'] }],
  brackets: [
    { stage: 'main', entrantIds: ['c'] },
    { stage: 'consolation', entrantIds: ['a', 'b'] },
  ],
  matches: [
    ['a', 'b'],
    ['b', 'c'],
    ['c', 'a'],
  ].map(([player1Id, player2Id]) => ({
    stage: 'group',
    poolId: 'pool',
    status: 'complete',
    outcome: 'played',
    player1Id: player1Id!,
    player2Id: player2Id!,
    winnerId: player1Id!,
    score1: 2,
    score2: 1,
  })),
};

it('uses the recorded order for a circular three-way tie and verifies the qualification split', () => {
  const facts = nativeDoublesPoolFacts(evidence, names);
  expect(facts.map(({ fact }) => fact)).toMatchObject([
    {
      kind: 'pool_tie',
      teams: [{ name: 'Pair C' }, { name: 'Pair A' }, { name: 'Pair B' }],
      setWins: 1,
      circular: true,
      splitFinals: true,
    },
    { kind: 'pool_deciders', closeSets: 3, totalSets: 3 },
  ]);
});

it('requires a complete pool and a matching recorded order before claiming a tie', () => {
  expect(
    nativeDoublesPoolFacts({ ...evidence, matches: evidence.matches.slice(1) }, names),
  ).toEqual([]);
  expect(nativeDoublesPoolFacts({ ...evidence, poolOrders: [] }, names)).toEqual([]);
});

it('shows a recorded set score from each side and suppresses missing or unplayed scores', () => {
  expect(playerSetScore('1-3', null, 1)).toBe('1–3');
  expect(playerSetScore('1-3', null, 2)).toBe('3–1');
  expect(playerSetScore(null, null, 1)).toBeNull();
  expect(playerSetScore('5-0', { outcome: 'forfeit' }, 1)).toBeNull();
});
