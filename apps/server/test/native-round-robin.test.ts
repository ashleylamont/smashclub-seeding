import { describe, expect, it } from 'vitest';
import { buildRoundRobin } from '@smashclub/tournament-formats';
import { pureBaseline, envelope } from './helpers/nativeLiveFixture';
import { captureBaseline, decide, reduceDecision, stableId } from '../src/tournament/domain';
import { applyAttendance, attendancePreview } from '../src/tournament/attendance';
import { eventView } from '../src/tournament/views';
import { createTestDb } from './helpers/testDb';

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

describe('round-robin planner confirmation guidance', () => {
  it('requires relocking a paused draw before offering confirmation', async () => {
    const { db, close } = await createTestDb();
    try {
      const state = captureBaseline(baseline(4, 1));
      for (const entrant of state.entrants) entrant.availability = 'withdrawn';
      for (const match of state.matches) {
        match.status = 'complete';
        match.outcome = 'no_contest';
      }
      const pool = state.pools[0]!;
      const paused = reduceDecision(state, decide(state, envelope({ kind: 'unlock' }))!);
      const confirmation = envelope({
        kind: 'poolOrders',
        pools: [
          {
            poolId: pool.id,
            expectedRevision: pool.revision,
            order: pool.entrantIds,
            matchRevisions: Object.fromEntries(state.matches.map((m) => [m.id, m.revision])),
          },
        ],
      });
      expect(paused.lifecycle).toBe('unlocked');
      expect(() => decide(paused, confirmation)).toThrow(/Relock/);
      expect((await eventView(db, paused, true)).poolOrders?.[0]).toMatchObject({
        status: 'manual_required',
        plannerConfirmation: {
          available: false,
          reason: 'Resume the pool draw to confirm this order.',
        },
      });
      const relocked = reduceDecision(paused, decide(paused, envelope({ kind: 'relock' }))!);
      expect((await eventView(db, relocked, true)).poolOrders?.[0]).toMatchObject({
        plannerConfirmation: { available: true },
      });
      expect(decide(relocked, confirmation)).toBeDefined();
    } finally {
      await close();
    }
  });

  it('only offers confirmation through the planner up to its existing entrant limit', async () => {
    const { db, close } = await createTestDb();
    try {
      for (const count of [16, 17]) {
        const state = captureBaseline(baseline(count, 1));
        for (const match of state.matches) {
          match.status = 'complete';
          match.outcome = 'played';
          match.score1 = 2;
          match.score2 = 0;
          match.winnerId = match.player1Id;
          match.started = true;
        }
        expect((await eventView(db, state, true)).poolOrders?.[0]).toMatchObject({
          status: 'manual_required',
          plannerConfirmation:
            count === 16
              ? { available: true }
              : {
                  available: false,
                  reason:
                    'This pool has 17 entrants. The planner can confirm orders for pools of 2–16 entrants.',
                },
        });
        expect((await eventView(db, state)).poolOrders?.[0]).not.toHaveProperty(
          'plannerConfirmation',
        );
      }
    } finally {
      await close();
    }
  });
});
