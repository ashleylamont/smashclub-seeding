import { describe, expect, it } from 'vitest';
import { loginSearch, operatorDestination, operatorPath } from '../src/lib/operatorDestination';

const plan = '3048c081-1afa-4eab-a0a0-622853293ae2';
const station = 'afcc7fd0-e377-4832-9de0-18a3fa0c194a';

describe('operator sign-in continuation', () => {
  it('builds the assigned route from canonical IDs and the broadcast view', () => {
    const target = operatorDestination({
      operate: plan.toUpperCase(),
      view: 'broadcast',
      station: station.toUpperCase(),
      token: 'fixture-invite',
      hash: '#fixture',
      returnTo: '/me',
    });
    expect(operatorPath(target!)).toBe(`/operate/${plan}?view=broadcast&station=${station}`);
  });

  it.each([['1'], [`${plan}\n`], ['/events'], [[plan]]])(
    'ignores an invalid plan ID %j',
    (operate) => {
      expect(operatorDestination({ operate })).toBeUndefined();
    },
  );

  it('ignores unsupported station and view combinations', () => {
    expect(operatorPath(operatorDestination({ operate: plan, view: '/play', station })!)).toBe(
      `/operate/${plan}`,
    );
    expect(operatorPath(operatorDestination({ operate: plan, view: 'history', station })!)).toBe(
      `/operate/${plan}?view=history`,
    );
    expect(
      operatorPath(operatorDestination({ operate: plan, view: 'broadcast', station: 'name' })!),
    ).toBe(`/operate/${plan}?view=broadcast`);
  });

  it('preserves an explicit profile-claim continuation', () => {
    expect(loginSearch({ claim: station, operate: plan }).claim).toBe(station);
    expect(operatorDestination(loginSearch({ claim: station, operate: plan }))).toBeUndefined();
  });
});
