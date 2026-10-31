import { describe, expect, it } from 'vitest';
import { buildEliminationTree, buildDoubleEliminationTree } from '@smashclub/engine';
import { matchNames } from '../src/tournament/matchNames';
import { matchRows } from '../src/tournament/views';
import { hash, stableId } from '../src/tournament/domain';
import { instantiateElimination } from '../src/tournament/structureAdapter';
import { pureState } from './helpers/nativeLiveFixture';

function draw(
  size: number,
  double = false,
  division: 'upper' | 'lower' = 'upper',
  stage: 'main' | 'consolation' = 'main',
) {
  const id = stableId(`${division}:${stage}`);
  const entrantIds = Array.from({ length: size }, (_, i) => stableId(`${id}:entrant:${i}`));
  const tree = (double ? buildDoubleEliminationTree : buildEliminationTree)(
    id,
    entrantIds.map((entrantId) => ({ kind: 'entrant', entrantId })),
  );
  return {
    matches: instantiateElimination(tree, id, division, stage),
    brackets: [{ id, division, stage, entrantIds }],
  };
}

describe('structural native display names', () => {
  for (const size of [2, 3, 4, 5, 8, 9, 16, 32]) {
    it(`names the fixed ${size}-entrant graph through its actual final without changing facts`, () => {
      const data = draw(size);
      const before = structuredClone(data);
      const labels = matchNames(data);
      const final = data.matches.at(-1)!;
      expect(labels.get(final.id)).toBe('Final');
      const first = data.matches[0]!;
      const rounds = Math.ceil(Math.log2(size));
      expect(labels.get(first.id)).toBe(
        rounds === 1
          ? 'Final'
          : rounds === 2
            ? 'Semi-final 1'
            : rounds === 3
              ? 'Quarter-final 1'
              : `Round of ${2 ** rounds} 1`,
      );
      expect(new Set(labels.values()).size).toBe(data.matches.length);
      // Attendance/outcomes and absent qualifiers never shrink the fixed draw.
      for (const match of data.matches)
        Object.assign(match, {
          player1Id: null,
          player2Id: null,
          status: 'complete',
          outcome: 'bye',
          winnerId: null,
        });
      data.brackets[0]!.entrantIds = data.brackets[0]!.entrantIds.map(
        (_, i) => `pending:pool:${i}`,
      );
      expect(matchNames(data)).toEqual(labels);
      expect(before.matches.map((m) => m.id)).toEqual(data.matches.map((m) => m.id));
    });
  }

  it('does not call an uncontested single-entrant draw a played final', () => {
    const data = draw(1);
    expect([...matchNames(data).values()]).toEqual(['Uncontested bracket']);
  });

  it('distinguishes winners, losers, grand final and conditional reset without renumbering by result', () => {
    const data = draw(8, true);
    const labels = matchNames(data);
    expect(
      labels.get(data.matches.find((m) => m.bracketLane === 'winners' && m.bracketRound === 1)!.id),
    ).toBe('Winners quarter-final 1');
    expect(
      labels.get(data.matches.find((m) => m.bracketLane === 'winners' && m.bracketRound === 3)!.id),
    ).toBe('Winners final');
    expect(labels.get(data.matches.find((m) => m.bracketLane === 'losers')!.id)).toBe(
      'Losers round 1 · Match 1',
    );
    expect(labels.get(data.matches.find((m) => m.bracketLane === 'final')!.id)).toBe('Grand final');
    const reset = data.matches.find((m) => m.bracketLane === 'reset')!;
    reset.skipped = true;
    expect(matchNames(data).get(reset.id)).toBe('Reset final (if needed)');
    expect(new Set(labels.values()).size).toBe(data.matches.length);
  });

  it('adds division and bracket role only to distinguish simultaneous draws', () => {
    const upper = draw(4),
      lower = draw(4, false, 'lower'),
      consolation = draw(3, false, 'upper', 'consolation');
    const all = {
      matches: [...upper.matches, ...lower.matches, ...consolation.matches],
      brackets: [...upper.brackets, ...lower.brackets, ...consolation.brackets],
    };
    const labels = matchNames(all);
    expect(labels.get(upper.matches.at(-1)!.id)).toBe('Upper · Championship · Final');
    expect(labels.get(lower.matches.at(-1)!.id)).toBe('Lower · Championship · Final');
    expect(labels.get(consolation.matches.at(-1)!.id)).toBe('Upper · Consolation · Final');
    expect(new Set(labels.values()).size).toBe(all.matches.length);
  });

  it('retains source labels when a partial or malformed graph cannot prove its round names', () => {
    for (const malformed of [false, true]) {
      const data = draw(8);
      if (malformed) data.matches[1]!.slot = data.matches[0]!.slot;
      else data.matches.pop();
      expect(matchNames(data)).toEqual(new Map(data.matches.map((m) => [m.id, m.label])));
    }
  });

  it('projects the shared name for player/TO/OBS/print consumers without mutating journal facts or pool labels', () => {
    const state = pureState();
    const data = draw(4);
    state.brackets = data.brackets;
    state.matches.push(...data.matches);
    const before = hash(state);
    const rows = matchRows(state);
    expect(rows.find((m) => m.id === data.matches[0]!.id)!.label).toBe('Semi-final 1');
    expect(rows.find((m) => m.id === data.matches.at(-1)!.id)!.label).toBe('Final');
    expect(rows.find((m) => m.stage === 'group')!.label).toBe(state.matches[0]!.label);
    expect(hash(state)).toBe(before);
  });
});
