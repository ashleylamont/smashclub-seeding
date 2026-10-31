import { describe, expect, it } from 'vitest';
import { matchPresentation, nextMeaningfulMatch } from '../src/lib/matchPresentation';
import { matchStatus } from '../src/lib/playerMatchView';
import type { PoolFlowData, PoolFlowMatch } from '../src/lib/poolFlow';
import { bracketFixture } from './fixtures/brackets';

const matches = bracketFixture(5, false);
const bye = matches.find((match) => match.outcome === 'bye')!;

describe('recorded match presentation', () => {
  it('names native first-round and propagated automatic byes without scores or reporting', () => {
    for (const match of [bye, { ...bye, parent1MatchId: 'resolved-feeder', score1: 99 }])
      expect(matchPresentation(match)).toMatchObject({
        kind: 'bye',
        status: 'Bye',
        result: `${bye.player1Name} advanced automatically.`,
        showScores: false,
        canReport: false,
      });
    const second = {
      ...bye,
      player1Id: null,
      player1Name: null,
      player2Id: 'b',
      player2Name: 'Bea',
      winnerId: 'b',
    };
    expect(matchPresentation(second).title).toBe('Bea · Bye');
    expect(matchPresentation(second).result).toBe('Bea advanced automatically.');
  });

  it('never infers an automatic bye from an unresolved qualifier, winner or loser feed', () => {
    for (const parent2Outcome of ['winner', 'loser'] as const) {
      const pending = {
        ...bye,
        outcome: null,
        winnerId: null,
        status: 'blocked',
        parent2MatchId: 'pending',
        parent2Outcome,
      };
      expect(matchPresentation(pending)).toMatchObject({
        kind: 'pending',
        status: 'Awaiting opponent',
        showScores: false,
        canReport: false,
      });
      expect(matchPresentation({ ...pending, parent2MatchId: null }).kind).toBe('pending');
      expect(matchPresentation({ ...pending, outcome: 'bye' }).kind).toBe('pending');
    }
  });

  it('describes forfeits and no-contests without historical sentinel scores', () => {
    const match = { ...bye, player2Id: 'b', player2Name: 'Bea', score1: 99, score2: 0 };
    expect(matchPresentation({ ...match, outcome: 'forfeit' })).toMatchObject({
      kind: 'forfeit',
      result: `${bye.player1Name} advances · Bea forfeits.`,
      showScores: false,
      canReport: false,
    });
    for (const state of [
      { status: 'complete', winnerId: null },
      {
        status: 'blocked',
        blockedReason: 'Both players withdrawn: no contest; no winner or score recorded',
      },
    ])
      expect(matchPresentation({ ...match, ...state, outcome: null })).toMatchObject({
        kind: 'no-contest',
        result: 'No contest. No winner or score recorded.',
        showScores: false,
        canReport: false,
      });
  });

  it('keeps played results reportable and preserves actual called versus playing', () => {
    const match = {
      ...bye,
      revision: 0,
      player2Id: 'b',
      player2Name: 'Bea',
      outcome: 'played',
      score1: 2,
      score2: 1,
    };
    expect(matchPresentation(match)).toMatchObject({
      kind: 'played',
      result: null,
      showScores: true,
      canReport: true,
    });
    const data: PoolFlowData = {
      plan: { id: 'event', status: 'underway' },
      matches: [],
      stations: [],
      poolSchedules: [],
    };
    expect(matchStatus(data, { ...match, status: 'playing', called: true } as PoolFlowMatch)).toBe(
      'Called',
    );
    expect(matchStatus(data, { ...match, status: 'playing', called: false } as PoolFlowMatch)).toBe(
      'Playing now',
    );
    expect(matchStatus(data, match)).toBe('Final result');
    expect(matchStatus(data, { ...bye, revision: 0 })).toBe('Bye');
  });

  it('finds a meaningful next match only after the snapshot actually places the advancing entrant', () => {
    const feeder = matches.find(
      (match) => match.parent1MatchId === bye.id || match.parent2MatchId === bye.id,
    )!;
    expect(nextMeaningfulMatch(matches, bye)).toBeUndefined();
    const assigned = { ...feeder, player1Id: bye.winnerId, player1Name: bye.player1Name };
    expect(nextMeaningfulMatch([...matches, assigned], bye)).toBe(assigned);
    expect(matchPresentation(assigned).kind).toBe('pending');
    expect(nextMeaningfulMatch([{ ...assigned, status: 'complete' }], bye)).toBeUndefined();
    expect(
      nextMeaningfulMatch(
        [
          {
            ...assigned,
            blockedReason: 'Both players withdrawn: no contest; no winner or score recorded',
          },
        ],
        bye,
      ),
    ).toBeUndefined();
    expect(nextMeaningfulMatch([assigned], { ...bye, outcome: 'forfeit' })).toBeUndefined();
  });
});
