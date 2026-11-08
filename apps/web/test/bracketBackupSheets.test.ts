import { describe, expect, it } from 'vitest';
import { buildRoundRobin } from '@smashclub/tournament-formats';
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

function roundRobinWorksheet(playoffSize?: number, consolation = false): BracketBackupData {
  const data = fixture();
  data.plan.structure = 'round_robin_finals';
  data.plan.structureOptions = { roundRobinMeetings: 1, playoffSize, consolation };
  data.entrants = Array.from({ length: 10 }, (_, index) => ({
    id: `player-${index + 1}`,
    name: `Player ${index + 1}`,
  }));
  const names = new Map(data.entrants.map(({ id, name }) => [id, name]));
  data.matches = buildRoundRobin(data.entrants.map(({ id }) => id)).map((pair) => ({
    ...data.matches[0]!,
    id: `pool-${pair.round}-${pair.slot}`,
    player1Id: pair.player1Id,
    player1Name: names.get(pair.player1Id)!,
    player2Id: pair.player2Id,
    player2Name: names.get(pair.player2Id)!,
  }));
  return data;
}

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
    expect(sheets[0].matches.map(({ key, label }) => [key, label])).toEqual([
      ['blank-1-0', 'Semi-final 1'],
      ['blank-1-1', 'Semi-final 2'],
      ['blank-2-0', 'Final'],
    ]);
    expect(sheets[0].matches[2]).toMatchObject({
      player1: 'Winner of Semi-final 1',
      player2: 'Winner of Semi-final 2',
    });
    expect(sheets[2].roster).toEqual([]);
  });

  it('fits a nine-place playoff and keeps all unassigned first-round slots writable', () => {
    const [sheet] = bracketBackupSheets(roundRobinWorksheet(9));
    expect(sheet.matches).toHaveLength(15);
    expect(sheet.matches.filter((match) => !match.player1 && !match.player2)).toHaveLength(8);
    expect(sheet.matches[0]).toMatchObject({ key: 'blank-1-0', label: 'Round of 16 1' });
    expect(sheet.matches[8]).toMatchObject({
      label: 'Quarter-final 1',
      player1: 'Winner of Round of 16 1',
      player2: 'Winner of Round of 16 2',
    });
    expect(sheet.matches.at(-1)).toMatchObject({ key: 'blank-4-0', label: 'Final' });
  });

  it('follows full-field, consolation, and active-entrant counts', () => {
    const defaultCut = roundRobinWorksheet();
    expect(bracketBackupSheets(defaultCut).map((sheet) => sheet.matches.length)).toEqual([15]);
    defaultCut.withdrawals = [{ playerId: 'player-9' }, { playerId: 'player-10' }];
    expect(bracketBackupSheets(defaultCut).map((sheet) => sheet.matches.length)).toEqual([7]);

    const shortCut = bracketBackupSheets(roundRobinWorksheet(3, true));
    expect(shortCut.map((sheet) => [sheet.title, sheet.matches.length])).toEqual([
      ['Open Championship', 3],
      ['Open Consolation', 7],
    ]);
    expect(
      bracketBackupSheets(roundRobinWorksheet(9, true)).map((sheet) => sheet.matches.length),
    ).toEqual([15, 3]);
  });

  it('keeps an unlinked provider worksheet generic', () => {
    const data = fixture();
    data.plan.bracketMode = 'challonge';
    const [sheet] = bracketBackupSheets(data);
    expect(sheet.matches).toHaveLength(16);
    expect(sheet.matches[0]).toEqual({
      key: 'blank-0',
      label: 'Match 1',
      round: 'Round ____',
      player1: '',
      player2: '',
      recorded: '',
    });
  });

  it('prints linked identifiers under their field heading and preserves fallback and row order', () => {
    const data = fixture();
    data.plan.bracketMode = 'challonge';
    data.brackets = [{ division: 'upper', stage: 'main', slug: 'linked-draw' }];
    const confirmed = {
      ...data.matches[0]!,
      id: 'linked-confirmed',
      stage: 'main',
      poolIndex: null,
      sourceSetId: 'imported-set',
      sourceKey: 'set:imported-set',
      label: 'upper main · 10 · Replay 2',
      status: 'complete',
      outcome: 'played',
      score1: 2,
      score2: 1,
    };
    data.matches.push(confirmed, {
      ...confirmed,
      id: 'unverified',
      sourceKey: 'manual-key',
      label: 'upper main · 2',
    });
    const [sheet] = bracketBackupSheets(data);
    expect(sheet).toMatchObject({
      title: 'Upper Championship',
      source: 'Challonge: linked-draw',
      matches: [
        { key: 'unverified', label: 'upper main · 2', recorded: '2–1' },
        { key: 'linked-confirmed', label: '10 · Replay 2', recorded: '2–1' },
      ],
    });
    expect(data.matches[1]?.label).toBe('upper main · 10 · Replay 2');
  });

  it('prints only the configured bracket roles and keeps round captions for unverified names', () => {
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
        labelFromStructure: true,
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
    expect(sheets[0]!.matches.map(({ key, label, round }) => [key, label, round])).toEqual([
      ['winners', 'Winners R1', 'Round 1'],
      ['final', 'Grand final', ''],
    ]);
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
