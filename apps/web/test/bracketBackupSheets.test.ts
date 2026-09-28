import { describe, expect, it } from 'vitest';
import { bracketBackupSheets, type BracketBackupData } from '../src/lib/bracketBackupSheets';

const fixture = (): BracketBackupData => ({
  plan: { bracketMode: 'native' },
  brackets: [],
  nativeBrackets: [],
  entrants: [
    { id: 'a', name: 'Alice' },
    { id: 'b', name: 'Bob' },
  ],
  matches: [
    {
      id: 'pool',
      division: 'upper',
      stage: 'group',
      poolIndex: 0,
      label: 'Upper Pool A',
      player1Id: 'a',
      player1Name: 'Alice',
      player2Id: 'b',
      player2Name: 'Bob',
      score1: null,
      score2: null,
      winnerId: null,
      status: 'ready',
      stationId: null,
    },
  ],
});

describe('TO bracket backup sheets', () => {
  it('provides four blank worksheets before the draw exists, with the division roster', () => {
    const sheets = bracketBackupSheets(fixture());
    expect(sheets.map((sheet) => sheet.title)).toEqual([
      'Upper Championship',
      'Upper Consolation',
      'Lower Championship',
      'Lower Consolation',
    ]);
    expect(sheets.every((sheet) => sheet.blank && sheet.matches.length > 0)).toBe(true);
    expect(sheets[0].roster).toEqual(['Alice', 'Bob']);
    expect(sheets[0].matches.map((match) => match.round)).toEqual([
      'Round 1',
      'Round 1',
      'Round 2',
    ]);
    expect(sheets[0].matches[2].player1).toBe('Winner of R1 M1');
    expect(sheets[2].roster).toEqual([]);
  });

  it('prints an existing native draw in round and slot order with winner dependencies', () => {
    const data = fixture();
    data.nativeBrackets = [
      { id: 'bracket', division: 'upper', stage: 'main', entrantIds: ['a', 'b'] },
    ];
    data.matches.push(
      {
        id: 'final',
        division: 'upper',
        stage: 'main',
        poolIndex: null,
        nativeBracketId: 'bracket',
        nativeRound: 2,
        nativeSlot: 0,
        parent1MatchId: 'semi-a',
        parent2MatchId: 'semi-b',
        label: 'Final',
        player1Id: null,
        player1Name: null,
        player2Id: null,
        player2Name: null,
        score1: null,
        score2: null,
        winnerId: null,
        status: 'blocked',
        stationId: null,
      },
      {
        id: 'semi-b',
        division: 'upper',
        stage: 'main',
        poolIndex: null,
        nativeBracketId: 'bracket',
        nativeRound: 1,
        nativeSlot: 1,
        label: 'Semi B',
        player1Id: null,
        player1Name: null,
        player2Id: null,
        player2Name: null,
        score1: null,
        score2: null,
        winnerId: null,
        status: 'blocked',
        stationId: null,
      },
      {
        id: 'semi-a',
        division: 'upper',
        stage: 'main',
        poolIndex: null,
        nativeBracketId: 'bracket',
        nativeRound: 1,
        nativeSlot: 0,
        label: 'Semi A',
        player1Id: 'a',
        player1Name: 'Alice',
        player2Id: 'b',
        player2Name: 'Bob',
        score1: 2,
        score2: 1,
        winnerId: 'a',
        status: 'complete',
        outcome: 'played',
        stationId: null,
      },
    );
    const sheet = bracketBackupSheets(data)[0];
    expect(sheet.blank).toBe(false);
    expect(sheet.matches.map((match) => match.label)).toEqual(['Semi A', 'Semi B', 'Final']);
    expect(sheet.matches[0].recorded).toBe('2–1');
    expect(sheet.matches[2].player1).toBe('Winner of Semi A');
    expect(sheet.matches[2].player2).toBe('Winner of Semi B');
  });
});
