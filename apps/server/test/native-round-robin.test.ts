import { describe, expect, it } from 'vitest';
import { buildRoundRobin } from '@smashclub/engine';
import { pureBaseline, envelope } from './helpers/nativeLiveFixture';
import { captureBaseline, stableId } from '../src/tournament/domain';
import { applyAttendance, attendancePreview } from '../src/tournament/attendance';

function baseline(count: number, meetings: number) {
  const value = pureBaseline();
  value.version = 2;
  value.competitionFormat = 'singles';
  value.structure = 'round_robin';
  value.structureOptions = { roundRobinMeetings: meetings };
  const template = value.entrants[0]!;
  value.entrants = Array.from({ length: count }, (_, i) => ({
    ...template,
    id: stableId(`entry:${i}`),
    playerId: stableId(`player:${i}`),
    seed: i + 1,
  }));
  const pool = { ...value.pools[0]!, entrantIds: value.entrants.map((e) => e.playerId) };
  value.pools = [pool];
  const match = value.matches[0]!;
  value.matches = buildRoundRobin(pool.entrantIds, meetings).map((p, i) => ({
    ...match,
    ...p,
    id: stableId(`match:${i}`),
    poolId: pool.id,
  }));
  return value;
}

describe('round-robin variant lifecycle rules', () => {
  it('validates exact pair multiplicities and keeps old one-meeting baselines readable', () => {
    const single = baseline(9, 1);
    delete single.structureOptions;
    expect(captureBaseline(single).matches).toHaveLength(36);
    const repeated = baseline(9, 2);
    expect(captureBaseline(repeated).matches).toHaveLength(72);
    repeated.matches[1]!.player1Id = repeated.matches[0]!.player1Id;
    repeated.matches[1]!.player2Id = repeated.matches[0]!.player2Id;
    expect(() => captureBaseline(repeated)).toThrow(/complete round-robin draw/);
  });

  it('adds every repeated pairing for a late entrant to an open RR and preserves existing match facts', () => {
    const state = captureBaseline(baseline(9, 2));
    const previous = structuredClone(state.matches);
    const playerId = stableId('late-player');
    const input = { action: 'add' as const, playerId, division: 'upper' as const };
    const preview = attendancePreview(state, input);
    expect(preview.allowed).toBe(true);
    expect(preview.addedMatches).toBe(18);
    const command = {
      kind: 'attendance' as const,
      ...input,
      reason: 'Joined before pool play',
      approveRedistribution: false,
      revisionToken: preview.revisionToken,
      entrant: {
        id: stableId('late-entry'),
        name: 'Late player',
        snapshotRank: null,
        snapshotScore: null,
      },
    };
    applyAttendance(state, envelope(command), command);
    expect(state.matches).toHaveLength(90);
    expect(state.matches.slice(0, previous.length)).toEqual(previous);
    const added = state.matches.slice(previous.length);
    expect(added.every((m) => [m.player1Id, m.player2Id].includes(playerId))).toBe(true);
    const opponents = added.map((m) => (m.player1Id === playerId ? m.player2Id : m.player1Id));
    expect(new Set(opponents).size).toBe(9);
    for (const round of new Set(state.matches.map((m) => m.round))) {
      const playing = state.matches
        .filter((m) => m.round === round)
        .flatMap((m) => [m.player1Id, m.player2Id]);
      expect(new Set(playing).size).toBe(playing.length);
    }
    for (const id of new Set(opponents)) expect(opponents.filter((p) => p === id)).toHaveLength(2);
    const remove = attendancePreview(state, { action: 'no_show', playerId });
    const removal = {
      kind: 'attendance' as const,
      action: 'no_show' as const,
      playerId,
      reason: 'Cannot attend',
      approveRedistribution: false,
      revisionToken: remove.revisionToken,
    };
    applyAttendance(state, envelope(removal), removal);
    expect(state.matches).toEqual(previous);
  });
});
