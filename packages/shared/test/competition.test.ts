import { describe, expect, it } from 'vitest';
import { structureOptionsSchema, structureIssues } from '../src/competition';
describe('native tournament structures', () => {
  it('keeps structural minimums without an arbitrary round-robin maximum', () => {
    expect(structureIssues('dual_division', 6)).toEqual([]);
    for (const count of [2, 8, 9, 32, 128, 1024])
      expect(structureIssues('round_robin', count)).toEqual([]);
    expect(structureIssues('dual_division', 4)).not.toEqual([]);
    expect(structureIssues('pools_finals', 2)).not.toEqual([]);
    expect(structureIssues('round_robin', 1)).not.toEqual([]);
    expect(structureIssues('round_robin', 2.5)).not.toEqual([]);
  });
  it('defaults existing formats to one meeting and accepts configurable repetitions', () => {
    expect(structureOptionsSchema.parse({})).toEqual({ roundRobinMeetings: 1 });
    expect(structureOptionsSchema.parse({ roundRobinMeetings: 3 })).toEqual({
      roundRobinMeetings: 3,
    });
    for (const value of [0, -1, 1.5, Infinity])
      expect(() => structureOptionsSchema.parse({ roundRobinMeetings: value })).toThrow(
        /Too small|Invalid input/,
      );
  });
});
