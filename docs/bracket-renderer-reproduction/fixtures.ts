import { bracketFixture, TEAM_ALIAS } from '../test/fixtures/brackets';

export { TEAM_ALIAS };

const stageNames = [
  'Upper Championship',
  'Upper Consolation',
  'Lower Championship',
  'Lower Consolation',
];

export type Shape = 'se' | 'de' | 'mixed';

export function fixtures(shape: Shape) {
  const stages = shape === 'mixed' ? stageNames : [shape === 'de' ? 'Native DE' : 'Native SE'];
  const size = shape === 'mixed' ? 4 : 7;
  const double = shape === 'de';
  return stages.map((name, index) => {
    const graph = bracketFixture(size, double);
    const played = graph.find((match) => match.player1Id && match.player2Id)!;
    Object.assign(played, {
      status: 'complete',
      outcome: 'played',
      winnerId: played.player2Id,
      score1: 1,
      score2: 2,
    });
    const noContest = double ? graph.find((match) => match.bracketLane === 'losers') : undefined;
    if (noContest) {
      Object.assign(noContest, {
        status: 'complete',
        blockedReason: 'Both players withdrew · no contest',
      });
    }
    return { name, index, size, double, graph, played, noContest };
  });
}
