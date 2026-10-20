import { describe, expect, it } from 'vitest';
import { recommendedStructure, structureIssues } from '../src/competition';
describe('native tournament structures', () => {
  it('recommends round robin, open pools, and two divisions by entrant count', () => {
    expect([2, 4, 5, 6, 8, 11, 12, 20].map(recommendedStructure)).toEqual([
      'round_robin',
      'round_robin',
      'round_robin',
      'pools_finals',
      'pools_finals',
      'pools_finals',
      'dual_division',
      'dual_division',
    ]);
  });
  it('validates deliberate overrides independently of recommendations', () => {
    expect(structureIssues('dual_division', 6)).toEqual([]);
    expect(structureIssues('round_robin', 8)).toEqual([]);
    expect(structureIssues('round_robin', 9)).not.toEqual([]);
    expect(structureIssues('dual_division', 4)).not.toEqual([]);
    expect(structureIssues('round_robin', 1)).not.toEqual([]);
  });
});
