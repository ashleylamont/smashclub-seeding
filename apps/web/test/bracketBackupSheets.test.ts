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

  it('prints only the configured bracket roles and labels loser feeds honestly', () => {
    const data = fixture();
    data.plan.structure = 'double_elimination';
    data.nativeBrackets = [
      { id: 'draw', division: 'upper', stage: 'main', entrantIds: ['a', 'b'] },
    ];
    data.matches = [
      {
        ...data.matches[0],
        id: 'winners',
        stage: 'main',
        nativeBracketId: 'draw',
        label: 'Winners R1',
        nativeRound: 1,
      },
      {
        ...data.matches[0],
        id: 'final',
        stage: 'main',
        nativeBracketId: 'draw',
        label: 'Grand final',
        nativeRound: 2,
        player1Id: null,
        player2Id: null,
        parent1MatchId: 'winners',
        parent2MatchId: 'winners',
        parent2Outcome: 'loser',
      },
    ];
    const sheets = bracketBackupSheets(data);
    expect(sheets).toHaveLength(1);
    expect(sheets[0]!.matches[1]!.player1).toBe('Winner of Winners R1');
    expect(sheets[0]!.matches[1]!.player2).toBe('Loser of Winners R1');
    data.plan.structure = 'round_robin';
    expect(bracketBackupSheets(data)).toEqual([]);
    data.plan.structure = 'round_robin_finals';
    data.plan.structureOptions = { roundRobinMeetings: 1, consolation: true };
    expect(bracketBackupSheets(data)).toHaveLength(2);
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
  it('keeps pending qualifiers, actual byes, no contests and conditional resets distinct on paper', () => {
    const data = fixture();
    data.plan.structure = 'double_elimination';
    data.nativeBrackets = [
      { id: 'draw', division: 'upper', stage: 'main', entrantIds: ['a', 'b'] },
    ];
    const match = { ...data.matches[0]!, nativeBracketId: 'draw', stage: 'main' };
    data.matches = [
      {
        ...match,
        id: 'pending',
        player1Id: null,
        player1Name: null,
        player1Qualifier: {
          poolId: 'pool',
          division: 'upper',
          poolIndex: 0,
          place: 1,
          status: 'pending',
        },
      },
      {
        ...match,
        id: 'bye',
        player2Id: null,
        player2Name: null,
        status: 'complete',
        outcome: 'bye',
        winnerId: 'a',
      },
      {
        ...match,
        id: 'no-contest',
        player2Id: null,
        player2Name: null,
        status: 'complete',
        outcome: 'no_contest',
      },
      { ...match, id: 'reset', bracketLane: 'reset', status: 'blocked' },
    ];
    const rows = bracketBackupSheets(data)[0]!.matches;
    expect(rows.find((row) => row.key === 'pending')!.player1).toContain('Pool A');
    expect(rows.find((row) => row.key === 'pending')!.player1).toContain('place 1');
    expect(rows.find((row) => row.key === 'bye')).toMatchObject({
      player2: 'Bye',
      recorded: 'Bye',
    });
    expect(rows.find((row) => row.key === 'no-contest')).toMatchObject({
      player2: 'No entrant',
      recorded: 'No contest',
    });
    expect(rows.find((row) => row.key === 'reset')!.recorded).toBe('If needed');
  });
});
