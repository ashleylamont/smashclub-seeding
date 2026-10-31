import { describe, expect, it } from 'vitest';
import { recentResultCount, resultStageLabel } from '../src/lib/broadcastSidebar';
import type { ResultMatch } from '../src/lib/broadcastResults';

describe('bounded broadcast result rail', () => {
  it('retains an OBS URL count while bounding invalid or excessive requests for the 720p rail', () => {
    expect(recentResultCount('')).toBe(2);
    expect(recentResultCount('?recent=1&station=stage&controls=0')).toBe(1);
    expect(recentResultCount('?recent=200')).toBe(2);
    expect(recentResultCount('?recent=0')).toBe(1);
    expect(recentResultCount('?recent=-2')).toBe(1);
    expect(recentResultCount('?recent=NaN')).toBe(2);
    expect(recentResultCount('?recent=')).toBe(2);
  });
  it('distinguishes pool, championship and consolation rounds using published labels', () => {
    const match = { division: 'upper', stage: 'group', poolIndex: 1, label: 'A1' } as ResultMatch;
    expect(resultStageLabel(match)).toBe('Upper · Pool B');
    expect(resultStageLabel({ ...match, stage: 'main', label: 'Winners round 2 · M3' })).toBe(
      'Upper · Championship · Winners round 2 · M3',
    );
    expect(
      resultStageLabel({ ...match, division: 'lower', stage: 'consolation', label: 'Final' }),
    ).toBe('Lower · Consolation · Final');
  });
});
