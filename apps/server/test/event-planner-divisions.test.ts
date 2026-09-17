import { describe, expect, it } from 'vitest';
import {
  EventPlanValidationError,
  assignDivisions,
  defaultUpperSize,
  validUpperSizes,
  validateDivisionInput,
  type DivisionCandidate,
} from '../src/event-planner/divisions';
import { parseRosterText } from '../src/event-planner/roster';

/** `count` ranked entrants, best rank first, in paste order. */
function ranked(count: number, from = 1): DivisionCandidate[] {
  return Array.from({ length: count }, (_, index) => ({
    entryId: `e${from + index}`,
    playerId: `p${from + index}`,
    divisionPreference: 'auto' as const,
    snapshotRank: from + index,
    sourceLineNumber: from + index,
  }));
}

const codes = (issues: { code: string }[]) => issues.map((issue) => issue.code);

describe('defaultUpperSize', () => {
  it('halves the field when both halves are whole pools', () => {
    expect(defaultUpperSize(16)).toBe(8);
    expect(defaultUpperSize(24)).toBe(12);
  });

  it('balances uneven attendance without requiring multiples of four', () => {
    expect(defaultUpperSize(20)).toBe(10);
    expect(defaultUpperSize(13)).toBe(7);
  });

  it('refuses a field too small for two divisions', () => {
    expect(defaultUpperSize(4)).toBeNull();
  });
});

describe('validUpperSizes', () => {
  it('offers every split that leaves both divisions whole pools', () => {
    expect(validUpperSizes(20)).toEqual(Array.from({ length: 15 }, (_, i) => i + 3));
    expect(validUpperSizes(8)).toEqual([3, 4, 5]);
    expect(validUpperSizes(5)).toEqual([]);
  });
});

describe('validateDivisionInput', () => {
  const options = { upperTargetSize: 8, poolSize: 4 };

  it('accepts a clean roster', () => {
    expect(validateDivisionInput(ranked(16), options)).toEqual([]);
  });

  it('rejects the same player on two rows', () => {
    const candidates = ranked(16);
    candidates[5] = { ...candidates[5]!, playerId: candidates[0]!.playerId };
    expect(codes(validateDivisionInput(candidates, options))).toContain('duplicate_player');
  });

  it('rejects an unranked entrant left on Auto', () => {
    const candidates = ranked(16);
    candidates[3] = { ...candidates[3]!, snapshotRank: null };
    expect(codes(validateDivisionInput(candidates, options))).toContain('unranked_needs_division');
  });

  it('accepts an unranked entrant once a division is pinned', () => {
    const candidates = ranked(16);
    candidates[3] = { ...candidates[3]!, snapshotRank: null, divisionPreference: 'lower' };
    expect(validateDivisionInput(candidates, options)).toEqual([]);
  });

  it('accepts a field that does not divide into fours', () => {
    expect(validateDivisionInput(ranked(14), options)).toEqual([]);
  });

  it('accepts balanced smaller pools', () => {
    expect(validateDivisionInput(ranked(16), { upperTargetSize: 6, poolSize: 4 })).toEqual([]);
  });

  it('rejects a division smaller than one pool', () => {
    expect(codes(validateDivisionInput(ranked(16), { upperTargetSize: 16, poolSize: 4 }))).toContain(
      'division_too_small',
    );
  });

  it('rejects pins that cannot fit the division they ask for', () => {
    const candidates = ranked(16).map((candidate, index) =>
      index < 9 ? { ...candidate, divisionPreference: 'upper' as const } : candidate,
    );
    expect(codes(validateDivisionInput(candidates, options))).toContain('pins_exceed_upper');
  });

  it('asks for an Upper size before anything else about the split', () => {
    expect(codes(validateDivisionInput(ranked(16), { upperTargetSize: null, poolSize: 4 }))).toContain(
      'upper_size_unset',
    );
  });

  it('reports every problem at once rather than the first', () => {
    const candidates = ranked(15);
    candidates[2] = { ...candidates[2]!, snapshotRank: null };
    const issues = codes(validateDivisionInput(candidates, { ...options, upperTargetSize: 15 }));
    expect(issues).toContain('unranked_needs_division');
    expect(issues).toContain('division_too_small');
  });
});

describe('assignDivisions', () => {
  const options = { upperTargetSize: 8, poolSize: 4 };

  it('fills Upper from the top of the ranking', () => {
    const placements = assignDivisions(ranked(16), options);
    const upper = placements.filter((placement) => placement.division === 'upper');
    expect(upper.map((placement) => placement.playerId)).toEqual(
      ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'],
    );
    expect(upper.map((placement) => placement.seed)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('seeds Lower from 1 again', () => {
    const lower = assignDivisions(ranked(16), options).filter((placement) => placement.division === 'lower');
    expect(lower.map((placement) => placement.seed)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(lower[0]!.playerId).toBe('p9');
  });

  it('honours a pin that contradicts the ranking', () => {
    const candidates = ranked(16);
    // The club's top player has asked to play Lower.
    candidates[0] = { ...candidates[0]!, divisionPreference: 'lower' };
    const placements = assignDivisions(candidates, options);
    const byPlayer = new Map(placements.map((placement) => [placement.playerId, placement]));
    expect(byPlayer.get('p1')!.division).toBe('lower');
    // Their Upper place goes to the next-best unpinned entrant.
    expect(byPlayer.get('p9')!.division).toBe('upper');
    expect(byPlayer.get('p1')!.pinned).toBe(true);
    expect(byPlayer.get('p9')!.pinned).toBe(false);
  });

  it('seeds a pinned player by rank within their division, not at the top', () => {
    const candidates = ranked(16);
    candidates[0] = { ...candidates[0]!, divisionPreference: 'lower' };
    const lower = assignDivisions(candidates, options).filter((placement) => placement.division === 'lower');
    expect(lower[0]!.playerId).toBe('p1');
  });

  it('seeds an unranked entrant below every ranked one in their division', () => {
    const candidates = ranked(16);
    candidates[1] = { ...candidates[1]!, snapshotRank: null, divisionPreference: 'upper' };
    const upper = assignDivisions(candidates, options).filter((placement) => placement.division === 'upper');
    expect(upper[upper.length - 1]!.playerId).toBe('p2');
  });

  it('orders two unranked entrants by the line they were pasted on', () => {
    const candidates = ranked(16);
    candidates[1] = { ...candidates[1]!, snapshotRank: null, divisionPreference: 'upper', sourceLineNumber: 9 };
    candidates[2] = { ...candidates[2]!, snapshotRank: null, divisionPreference: 'upper', sourceLineNumber: 3 };
    const upper = assignDivisions(candidates, options).filter((placement) => placement.division === 'upper');
    expect(upper.slice(-2).map((placement) => placement.playerId)).toEqual(['p3', 'p2']);
  });

  it('places every entrant exactly once', () => {
    const placements = assignDivisions(ranked(24), { upperTargetSize: 12, poolSize: 4 });
    expect(new Set(placements.map((placement) => placement.playerId)).size).toBe(24);
    expect(placements.filter((placement) => placement.division === 'upper')).toHaveLength(12);
  });

  it('throws with every issue attached rather than guessing', () => {
    try {
      assignDivisions(ranked(15), { ...options, upperTargetSize: 15 });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EventPlanValidationError);
      expect(codes((error as EventPlanValidationError).issues)).toContain('division_too_small');
    }
  });
});

describe('parseRosterText', () => {
  it('takes one entrant per non-empty line', () => {
    expect(parseRosterText('Fox McCloud\n\nFalco Lombardi\n').map((line) => line.input)).toEqual([
      'Fox McCloud',
      'Falco Lombardi',
    ]);
  });

  it('keeps the original line and its number for corrections', () => {
    const [, second] = parseRosterText('Fox\n\n  - Falco  ');
    expect(second).toMatchObject({ lineNumber: 3, rawInput: '- Falco', input: 'Falco' });
  });

  it('strips copied-list decoration', () => {
    const inputs = parseRosterText(
      ['- Fox', '* Falco', '• Wolf', '1. Krystal', '12) Peppy', '(3) Slippy'].join('\n'),
    ).map((line) => line.input);
    expect(inputs).toEqual(['Fox', 'Falco', 'Wolf', 'Krystal', 'Peppy', 'Slippy']);
  });

  it('does not split on commas, which are part of real display names', () => {
    const [only] = parseRosterText('[Atlas] Fox, back from injury');
    expect(only!.input).toBe('[Atlas] Fox, back from injury');
  });

  it('leaves company tags and @ conventions for the cleaner to handle', () => {
    expect(parseRosterText('- [Atlas]@Lucina - ready to taunt')[0]!.input).toBe('[Atlas]@Lucina - ready to taunt');
  });

  it('keeps a name that legitimately starts with a digit', () => {
    expect(parseRosterText('1UP Kirby')[0]!.input).toBe('1UP Kirby');
  });

  it('drops a line that was nothing but decoration', () => {
    expect(parseRosterText('Fox\n---\nFalco')).toHaveLength(2);
  });

  it('handles CRLF pastes from a spreadsheet', () => {
    expect(parseRosterText('Fox\r\nFalco').map((line) => line.input)).toEqual(['Fox', 'Falco']);
  });
});
