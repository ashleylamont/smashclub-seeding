import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildRoundRobin } from '@smashclub/engine';
import { captureBaseline, decide, hash, reduceDecision, stableId } from '../src/tournament/domain';
import { Baseline, Decision, LiveState } from '../src/tournament/schemas';
import { bracketViews, matchRows } from '../src/tournament/views';
import { dispatchAvailability } from '../src/tournament/dispatch';
import { previewRollingFinals } from '../src/tournament/finalsPreview';
import { envelope, pureBaseline } from './helpers/nativeLiveFixture';
import type { TournamentCommand, TournamentState } from '../src/tournament/schemas';

function apply(state: TournamentState, command: TournamentCommand, operator = true) {
  return LiveState.parse(
    reduceDecision(
      state,
      Decision.parse(decide(state, envelope(command, { operator, actorId: crypto.randomUUID() }))!),
    ),
  );
}
function initial() {
  const baseline = pureBaseline();
  baseline.settings.poolOrderPolicy = 'unique_set_wins_v1';
  baseline.settings.finalsProgression = 'rolling_pool_places_v1';
  return captureBaseline(baseline);
}
const score = (match: TournamentState['matches'][number], reverse = false) => ({
  kind: 'score' as const,
  matchId: match.id,
  expectedRevision: match.revision,
  score1: reverse ? 0 : 2,
  score2: reverse ? 2 : 0,
  outcome: 'played' as const,
});
function completePool(state: TournamentState, poolId: string) {
  const pool = state.pools.find((p) => p.id === poolId)!;
  for (const match of state.matches.filter((m) => m.poolId === poolId && m.status !== 'complete'))
    state = apply(
      state,
      score(
        match,
        pool.entrantIds.indexOf(match.player1Id!) > pool.entrantIds.indexOf(match.player2Id!),
      ),
    );
  return state;
}
function withPools(sizes: number[]) {
  const baseline = pureBaseline();
  baseline.version = 2;
  baseline.competitionFormat = 'singles';
  baseline.structure = 'pools_finals';
  baseline.settings.poolOrderPolicy = 'unique_set_wins_v1';
  baseline.settings.finalsProgression = 'rolling_pool_places_v1';
  const entrant = baseline.entrants[0]!;
  const pool = baseline.pools[0]!;
  const match = baseline.matches[0]!;
  baseline.entrants = [];
  baseline.pools = [];
  baseline.matches = [];
  for (const [index, size] of sizes.entries()) {
    const ids = Array.from({ length: size }, (_, i) => stableId(`pool:${index}:entrant:${i}`));
    const poolId = stableId(`custom-pool:${index}`);
    baseline.entrants.push(
      ...ids.map((id, i) => ({
        ...entrant,
        id: stableId(`entry:${id}`),
        playerId: id,
        seed: index * 5 + i + 1,
      })),
    );
    baseline.pools.push({ ...pool, id: poolId, index, entrantIds: ids });
    baseline.matches.push(
      ...buildRoundRobin(ids).map((pair, i) => ({
        ...match,
        ...pair,
        id: stableId(`${poolId}:match:${i}`),
        sourceKey: `${poolId}:${i}`,
        poolId,
      })),
    );
  }
  return captureBaseline(baseline);
}
function confirm(state: TournamentState, poolId: string) {
  const pool = state.pools.find((p) => p.id === poolId)!;
  return apply(state, {
    kind: 'placements',
    poolId,
    order: pool.entrantIds,
    expectedRevision: pool.revision,
    matchRevisions: Object.fromEntries(
      state.matches.filter((m) => m.poolId === poolId).map((m) => [m.id, m.revision]),
    ),
  });
}
function shared(state: TournamentState) {
  return apply(state, {
    kind: 'configureDispatch',
    capacity: 2,
    reservedStationIds: [],
    expectedResourceRevision: state.settings.resourceRevision,
  });
}

describe('native rolling-finals progression', () => {
  it('reproduces the pre-rolling whole-event gate despite known eligible upper finals', () => {
    const baseline = pureBaseline();
    baseline.settings.poolOrderPolicy = 'unique_set_wins_v1';
    let state = captureBaseline(baseline);
    for (const match of state.matches.filter((m) => m.division === 'upper'))
      state = apply(state, {
        kind: 'score',
        matchId: match.id,
        expectedRevision: match.revision,
        score1: 2,
        score2: 0,
        outcome: 'played',
      });
    expect(state.pools[0]!.order).toEqual(state.pools[0]!.entrantIds);
    expect(state.pools[1]!.order).toBeNull();
    expect(() => apply(state, { kind: 'drawFinals' })).toThrow(
      /Resolve pools and confirm their placements/,
    );
  });

  it('keeps the exact pre-rolling V2 journal state and policy after replay', () => {
    const journal = JSON.parse(
      readFileSync(new URL('./fixtures/native-pool-order-v2.json', import.meta.url), 'utf8'),
    );
    expect(journal.sourceCommit).toBe('9d8d398');
    const state = (journal.decisions as unknown[])
      .map((d) => Decision.parse(d))
      .reduce(reduceDecision, captureBaseline(Baseline.parse(journal.baseline)));
    expect(hash(state)).toBe(journal.stateHash);
    expect(state.settings.finalsProgression).toBeUndefined();
    expect(state.pools[0]!.orderDecision!.source).toBe('manual');
    expect(decide(state, envelope(score(state.matches[0]!)))!.version).toBe(2);
  });

  it('persists a full symbolic draw without treating pending qualifiers as byes, winners or complete brackets', () => {
    const before = initial();
    const request = envelope({ kind: 'drawFinals' });
    const fact = Decision.parse(decide(before, request)!);
    expect(fact.version).toBe(3);
    const state = LiveState.parse(reduceDecision(before, fact));
    expect(state.brackets).toHaveLength(4);
    expect(
      state.brackets.every((b) => b.entrantIds.length === 0 && b.qualifierSlots!.length === 2),
    ).toBe(true);
    expect(
      state.matches
        .filter((m) => m.bracketId)
        .every((m) => m.status === 'blocked' && m.outcome === null && !m.winnerId),
    ).toBe(true);
    expect(bracketViews(state).every((b) => !b.complete)).toBe(true);
    expect(state.pools[0]!.qualifierRoster).toEqual(before.pools[0]!.entrantIds);
    expect(decide(state, request)).toBeUndefined();
  });

  it('releases only the completed pool into shared capacity while an unrelated pool stays held', () => {
    let state = shared(initial());
    const pool = state.pools[0]!;
    state = apply(state, { kind: 'drawFinals' });
    state = completePool(state, pool.id);
    expect(state.pools[0]!.orderDecision!.source).toBe('automatic');
    const ready = state.matches.find(
      (m) => m.bracketId && m.division === 'upper' && m.stage === 'main',
    )!;
    const waiting = state.matches.find((m) => m.bracketId && m.division === 'lower')!;
    expect(ready.status).toBe('ready');
    expect(ready.player1Id).toBe(pool.entrantIds[0]);
    expect(ready.player2Id).toBe(pool.entrantIds[1]);
    expect(waiting.status).toBe('blocked');
    expect(waiting.blockedReason).toContain('lower pool A');
    expect(dispatchAvailability(state, ready).canDispatchOrdinary).toBe(true);
    state = apply(state, {
      kind: 'dispatch',
      matchId: ready.id,
      stationId: null,
      callOnly: true,
      expectedRevision: ready.revision,
      expectedResourceRevision: state.settings.resourceRevision,
    });
    expect(state.matches.find((m) => m.id === ready.id)!.status).toBe('playing');
    expect(
      state.matches
        .filter((m) => m.poolId === state.pools[1]!.id)
        .every((m) => m.status === 'ready'),
    ).toBe(true);
    expect(state.result).toBeNull();
    expect(state.publication).toBeNull();
  });

  it('does not advance a pending source paired with a genuine structural bye', () => {
    let state = apply(withPools([5]), { kind: 'drawFinals' });
    const pendingBye = state.matches.find(
      (m) => m.bracketId && Boolean(m.player1Qualifier) !== Boolean(m.player2Qualifier),
    )!;
    expect(pendingBye).toBeDefined();
    expect(pendingBye.status).toBe('blocked');
    expect(pendingBye.outcome).toBeNull();
    state = completePool(state, state.pools[0]!.id);
    const bye = state.matches.find((m) => m.id === pendingBye.id)!;
    expect(bye.outcome).toBe('bye');
    expect(bye.winnerId).toBeTruthy();
    expect(bye.score1).toBeNull();
    expect(bye.score2).toBeNull();
  });

  it('accepts a tied pool ruling after another final has started without changing played opponents', () => {
    let state = shared(initial());
    state = apply(state, { kind: 'drawFinals' });
    state = completePool(state, state.pools[0]!.id);
    const final = state.matches.find(
      (m) => m.bracketId && m.division === 'upper' && m.stage === 'main',
    )!;
    state = apply(state, {
      kind: 'dispatch',
      matchId: final.id,
      stationId: null,
      expectedRevision: final.revision,
      expectedResourceRevision: state.settings.resourceRevision,
    });
    state = apply(state, score(state.matches.find((m) => m.id === final.id)!));
    const actual = structuredClone(state.matches.find((m) => m.id === final.id)!);
    const pool = state.pools[1]!;
    state = completePool(state, pool.id);
    const cycle = state.matches.find(
      (m) => m.player1Id === pool.entrantIds[0] && m.player2Id === pool.entrantIds[2],
    )!;
    state = apply(state, score(cycle, true));
    expect(state.pools[1]!.order).toBeNull();
    state = confirm(state, pool.id);
    expect(state.matches.find((m) => m.id === final.id)).toEqual(actual);
    expect(
      state.matches
        .filter((m) => m.bracketId && m.division === 'lower')
        .every((m) => m.status === 'ready'),
    ).toBe(true);
  });

  it('accepts a consumed-pool dispute, retains actual IDs, blocks future relevant calls, and restores on rejection', () => {
    let state = shared(initial());
    state = completePool(state, state.pools[0]!.id);
    state = apply(state, { kind: 'drawFinals' });
    const final = state.matches.find(
      (m) => m.bracketId && m.division === 'upper' && m.stage === 'main',
    )!;
    state = apply(state, {
      kind: 'dispatch',
      matchId: final.id,
      stationId: null,
      callOnly: true,
      expectedRevision: final.revision,
      expectedResourceRevision: state.settings.resourceRevision,
    });
    const actualIds = [final.player1Id, final.player2Id];
    state = apply(state, score(state.matches[0]!, true), false);
    const called = state.matches.find((m) => m.id === final.id)!;
    expect([called.player1Id, called.player2Id]).toEqual(actualIds);
    expect(called.status).toBe('playing');
    expect(called.qualificationBlocks).not.toHaveLength(0);
    const other = state.matches.find(
      (m) => m.bracketId && m.division === 'upper' && m.stage === 'consolation',
    )!;
    expect(dispatchAvailability(state, other).canDispatchOrdinary).toBe(false);
    expect(other.qualificationBlocks![0]!.status).toBe('review_pending');
    const report = state.reports.at(-1)!;
    expect(report.status).toBe('pending');
    expect(() =>
      apply(state, {
        kind: 'review',
        reportId: report.id,
        approve: true,
        expectedRevision: state.matches[0]!.revision,
      }),
    ).toThrow(/Finals already use/);
    state = apply(state, {
      kind: 'review',
      reportId: report.id,
      approve: false,
      expectedRevision: state.matches[0]!.revision,
    });
    expect(state.matches.find((m) => m.id === final.id)!.qualificationBlocks).toBeUndefined();
    expect(
      dispatchAvailability(
        state,
        state.matches.find((m) => m.id === other.id)!,
      ).canDispatchOrdinary,
    ).toBe(true);
  });

  it('ignores unrelated and obsolete reviews without holding eligible finals', () => {
    let state = shared(initial());
    state = apply(state, { kind: 'drawFinals' });
    state = completePool(state, state.pools[0]!.id);
    const unrelated = state.matches.find((m) => m.poolId === state.pools[1]!.id)!;
    state.settings.scoreReportingMode = 'to_review';
    state = apply(state, score(unrelated), false);
    const final = state.matches.find((m) => m.bracketId && m.division === 'upper')!;
    expect(dispatchAvailability(state, final).canDispatchOrdinary).toBe(true);
    state = apply(state, score(unrelated));
    expect(
      state.reports.some(
        (r) =>
          r.status === 'pending' &&
          r.expectedRevision !== state.matches.find((m) => m.id === unrelated.id)!.revision,
      ),
    ).toBe(true);
    expect(
      dispatchAvailability(
        state,
        state.matches.find((m) => m.id === final.id)!,
      ).canDispatchOrdinary,
    ).toBe(true);
  });

  for (const held of [false, true])
    it(`preserves released actual play and ${held ? 'an explicit TO hold' : 'ready status'} across a pool review`, () => {
      let state = shared(initial());
      state = completePool(state, state.pools[0]!.id);
      state = apply(state, { kind: 'drawFinals' });
      const id = state.matches.find(
        (m) => m.bracketId && m.division === 'upper' && m.stage === 'main',
      )!.id;
      let final = state.matches.find((m) => m.id === id)!;
      state = apply(state, {
        kind: 'dispatch',
        matchId: id,
        stationId: null,
        callOnly: false,
        expectedRevision: final.revision,
        expectedResourceRevision: state.settings.resourceRevision,
      });
      final = state.matches.find((m) => m.id === id)!;
      state = apply(state, {
        kind: 'matchControl',
        matchId: id,
        status: held ? 'blocked' : 'ready',
        stationId: null,
        reason: held ? 'Explicit TO hold' : null,
        expectedRevision: final.revision,
        expectedResourceRevision: state.settings.resourceRevision,
      });
      state = apply(state, score(state.matches[0]!, true), false);
      final = state.matches.find((m) => m.id === id)!;
      expect(final.started).toBe(true);
      expect(final.status).toBe(held ? 'blocked' : 'ready');
      expect(dispatchAvailability(state, final).canDispatchOrdinary).toBe(false);
      const completed = held ? null : apply(state, score(final));
      expect(completed?.matches.find((m) => m.id === id)?.status ?? null).toBe(
        held ? null : 'complete',
      );
      const report = state.reports.at(-1)!;
      state = apply(state, {
        kind: 'review',
        reportId: report.id,
        approve: false,
        expectedRevision: state.matches[0]!.revision,
      });
      final = state.matches.find((m) => m.id === id)!;
      expect(final.started).toBe(true);
      expect(final.status).toBe(held ? 'blocked' : 'ready');
      expect(final.blockedReason).toBe(held ? 'Explicit TO hold' : null);
      expect(dispatchAvailability(state, final).canDispatchOrdinary).toBe(!held);
    });

  for (const size of [4, 5])
    it(`matches whole-event seeding after a ${size}→${size - 1} pre-draw withdrawal, including recompressed cut/byes`, () => {
      let state = withPools([size, 3]);
      for (const p of state.pools) state = completePool(state, p.id);
      const entrant = state.entrants[0]!;
      state = apply(state, {
        kind: 'availability',
        playerId: entrant.playerId,
        availability: 'withdrawn',
        expectedRevision: entrant.revision,
        reason: 'Before finals reservation',
      });
      const legacy = structuredClone(state);
      delete legacy.settings.finalsProgression;
      const request = envelope({ kind: 'drawFinals' });
      const old = reduceDecision(legacy, decide(legacy, request)!);
      const rolling = reduceDecision(state, decide(state, request)!);
      const topology = (value: TournamentState) =>
        value.matches
          .filter((m) => m.bracketId)
          .map((m) => [
            m.id,
            m.parent1Id,
            m.parent2Id,
            m.player1Id,
            m.player2Id,
            m.status,
            m.outcome,
            m.winnerId,
          ]);
      expect(topology(rolling)).toEqual(topology(old));
      expect(rolling.brackets.map((b) => b.entrantIds)).toEqual(
        old.brackets.map((b) => b.entrantIds),
      );
    });

  it('freezes eligibility at early creation and preserves it across withdrawal and restoration without shrinking the field', () => {
    let state = withPools([5, 3]);
    const excluded = state.entrants[0]!;
    state = apply(state, {
      kind: 'availability',
      playerId: excluded.playerId,
      availability: 'withdrawn',
      expectedRevision: 0,
      reason: 'Before reservation',
    });
    state = apply(state, { kind: 'drawFinals' });
    const slots = state.brackets.map((b) => b.qualifierSlots!.map((s) => [s.poolId, s.place]));
    expect(state.pools[0]!.qualifierRoster).not.toContain(excluded.playerId);
    state = apply(state, {
      kind: 'availability',
      playerId: excluded.playerId,
      availability: 'available',
      expectedRevision: 1,
      reason: 'Returned after reservation',
    });
    expect(state.pools[0]!.qualifierRoster).not.toContain(excluded.playerId);
    const later = state.entrants[1]!;
    state = apply(state, {
      kind: 'availability',
      playerId: later.playerId,
      availability: 'withdrawn',
      expectedRevision: 0,
      reason: 'After reservation',
    });
    expect(state.pools[0]!.qualifierRoster).toContain(later.playerId);
    expect(state.brackets.map((b) => b.qualifierSlots!.map((s) => [s.poolId, s.place]))).toEqual(
      slots,
    );
    expect(previewRollingFinals(state).freezeWarning).toContain('will not shrink or reseed');
  });

  it('resolves recompressed places from the frozen eligible roster even when an excluded entrant returns and wins their pool', () => {
    let state = withPools([5, 3]);
    const excluded = state.entrants[0]!;
    state = apply(state, {
      kind: 'availability',
      playerId: excluded.playerId,
      availability: 'withdrawn',
      expectedRevision: 0,
      reason: 'Absent before creation',
    });
    state = apply(state, { kind: 'drawFinals' });
    state = apply(state, {
      kind: 'availability',
      playerId: excluded.playerId,
      availability: 'available',
      expectedRevision: 1,
      reason: 'Returned after creation',
    });
    const pool = state.pools[0]!;
    state = completePool(state, pool.id);
    expect(state.pools[0]!.order![0]).toBe(excluded.playerId);
    expect(state.brackets.every((b) => !b.entrantIds.includes(excluded.playerId))).toBe(true);
    const first = state.brackets
      .find((b) => b.stage === 'main')!
      .qualifierSlots!.find((s) => s.poolId === pool.id && s.place === 1)!;
    expect(first.entrantId).toBe(pool.entrantIds[1]);
    expect(
      state.brackets.flatMap((b) => b.qualifierSlots!).filter((s) => s.poolId === pool.id),
    ).toHaveLength(4);
  });

  it('waits for explicit pool forfeits after a late withdrawal, then records a real withdrawn qualifier as a forfeit instead of a bye', () => {
    let state = apply(initial(), { kind: 'drawFinals' });
    const pool = state.pools[0]!;
    const withdrawn = pool.entrantIds[0]!;
    state = apply(state, {
      kind: 'availability',
      playerId: withdrawn,
      availability: 'withdrawn',
      expectedRevision: 0,
      reason: 'After field creation',
    });
    expect(state.matches.filter((m) => m.bracketId).every((m) => m.outcome === null)).toBe(true);
    for (const m of state.matches.filter((m) => m.poolId === pool.id))
      state = apply(
        state,
        [m.player1Id, m.player2Id].includes(withdrawn)
          ? {
              ...score(m),
              outcome: 'forfeit',
              score1: null,
              score2: null,
              winnerId: m.player1Id === withdrawn ? m.player2Id! : m.player1Id!,
            }
          : score(m),
      );
    const final = state.matches.find(
      (m) => m.bracketId && [m.player1Id, m.player2Id].includes(withdrawn),
    )!;
    expect(state.pools[0]!.qualifierRoster).toContain(withdrawn);
    expect(final.outcome).toBe('forfeit');
    expect(final.winnerId).toBe(pool.entrantIds[3]);
    expect(final.score1).toBeNull();
    expect(final.score2).toBeNull();
    expect([final.player1Id, final.player2Id]).toContain(withdrawn);
  });

  it('exposes truthful coarse source metadata and separates an existing played draw from reset/recreation', () => {
    let state = apply(initial(), { kind: 'drawFinals' });
    const before = previewRollingFinals(state);
    expect(before.existing).toBe(true);
    expect(before.allowed).toBe(false);
    expect(before.resetAllowed).toBe(true);
    const waiting = matchRows(state).find((m) => m.nativeBracketId)!;
    expect(waiting.player1Qualifier!.status).toBe('pending');
    expect(waiting.player1Id).toBeNull();
    state = completePool(state, state.pools[0]!.id);
    const final = state.matches.find((m) => m.bracketId && m.division === 'upper')!;
    state = apply(state, score(final));
    const after = previewRollingFinals(state);
    expect(after.allowed).toBe(false);
    expect(after.resetAllowed).toBe(false);
    expect(after.resetIssues.join(' ')).toContain('actual play');
    expect(after.brackets.flatMap((b) => b.roundOne).some((m) => m.status === 'complete')).toBe(
      true,
    );
  });
});
