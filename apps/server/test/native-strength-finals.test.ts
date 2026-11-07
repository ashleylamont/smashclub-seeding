import { buildRoundRobin } from '@smashclub/engine';
import { describe, expect, it } from 'vitest';
import { attendancePreview } from '../src/tournament/attendance';
import { captureBaseline, decide, reduceDecision, stableId } from '../src/tournament/domain';
import { previewStrengthFinals } from '../src/tournament/finalsPreview';
import { strengthSeedPolicy } from '../src/tournament/strengthFinals';
import { Decision, type TournamentCommand, type TournamentState } from '../src/tournament/schemas';
import { envelope, pureBaseline } from './helpers/nativeLiveFixture';

function initial() {
  const baseline = pureBaseline();
  baseline.settings.poolOrderPolicy = 'unique_set_wins_v1';
  baseline.settings.finalsProgression = 'rolling_pool_places_v1';
  baseline.entrants[0]!.snapshotScore = null;
  baseline.entrants[1]!.snapshotScore = 1910;
  return captureBaseline(baseline);
}

const score = (match: TournamentState['matches'][number], reverse = false): TournamentCommand => ({
  kind: 'score',
  matchId: match.id,
  expectedRevision: match.revision,
  score1: reverse ? 0 : 2,
  score2: reverse ? 2 : 0,
  outcome: 'played',
});

function run(state: TournamentState, command: TournamentCommand) {
  return reduceDecision(state, Decision.parse(decide(state, envelope(command))!));
}

function finish(state: TournamentState, division: 'upper' | 'lower') {
  const pool = state.pools.find((p) => p.division === division)!;
  for (const match of state.matches.filter((m) => m.poolId === pool.id && m.status !== 'complete'))
    state = run(state, score(match));
  return state;
}

function draw(preview: ReturnType<typeof previewStrengthFinals>): TournamentCommand {
  return {
    kind: 'drawFinals',
    revisionToken: preview.revisionToken,
    seedPolicy: strengthSeedPolicy,
  };
}

describe('native combined-strength finals', () => {
  it('gates each bracket on its own qualifiers and keeps other pool play out of the approval token', () => {
    let state = initial();
    expect(previewStrengthFinals(state)).toMatchObject({
      allowed: false,
      brackets: [],
      waitingStages: expect.any(Array),
    });
    expect(previewStrengthFinals(state).waitingStages).toHaveLength(4);
    state = finish(state, 'upper');
    const preview = previewStrengthFinals(state);
    expect(preview.brackets.map((bracket) => bracket.division)).toEqual(['upper', 'upper']);
    expect(preview.waitingStages.map((stage) => stage.division)).toEqual(['lower', 'lower']);
    const main = preview.brackets.find((b) => b.stage === 'main')!;
    expect(main.strengthSeeding!.seeds[0]).toMatchObject({
      place: 2,
      strength: 1910,
      strengthSource: 'frozen',
    });
    expect(main.strengthSeeding!.seeds[1]).toMatchObject({ place: 1, strengthSource: 'prior' });

    const lowerMatch = state.matches.find((m) => m.division === 'lower')!;
    state = run(state, score(lowerMatch));
    expect(previewStrengthFinals(state).revisionToken).toBe(preview.revisionToken);
    const command = envelope(draw(preview));
    const fact = Decision.parse(decide(state, command)!);
    expect(fact.version).toBe(6);
    expect(fact.after.brackets?.map((b) => b.strengthSeeding)).toEqual(
      preview.brackets.map((b) => b.strengthSeeding),
    );
    state = reduceDecision(state, fact);
    expect(decide(state, command)).toBeUndefined();
    const original = structuredClone(state.brackets);
    const upperSet = state.matches.find((m) => m.division === 'upper' && m.poolId)!;
    expect(() => run(state, score(upperSet, true))).toThrow(/Finals already use/);
    state = finish(state, 'lower');
    expect(() => run(state, draw(preview))).toThrow(/preview/);
    state = run(state, draw(previewStrengthFinals(state)));
    expect(state.brackets.slice(0, 2)).toEqual(original);
    expect(state.brackets).toHaveLength(4);
  });

  it('creates a championship with two certain places while the same pool still owes a consolation ruling', () => {
    const baseline = pureBaseline();
    baseline.version = 2;
    baseline.competitionFormat = 'singles';
    baseline.structure = 'round_robin_finals';
    baseline.structureOptions = { roundRobinMeetings: 2, playoffSize: 2, consolation: true };
    baseline.settings.poolOrderPolicy = 'unique_set_wins_v1';
    baseline.settings.finalsProgression = 'rolling_pool_places_v1';
    baseline.pools = baseline.pools.filter((pool) => pool.division === 'upper');
    baseline.entrants = baseline.entrants.filter((entrant) => entrant.division === 'upper');
    const pool = baseline.pools[0]!;
    const template = baseline.matches.find((match) => match.poolId === pool.id)!;
    const matches = buildRoundRobin(pool.entrantIds, 2);
    baseline.matches = matches.map((match, i) => ({
      ...template,
      ...match,
      id: stableId(`repeated-pool-set:${i}`),
    }));
    let state = captureBaseline(baseline);
    for (const match of state.matches) {
      const left = pool.entrantIds.indexOf(match.player1Id!);
      const right = pool.entrantIds.indexOf(match.player2Id!);
      const tiedBottomPair = left >= 2 && right >= 2;
      state = run(state, score(match, !tiedBottomPair && left > right));
    }
    expect(state.pools[0]?.order).toBeNull();
    const preview = previewStrengthFinals(state);
    expect(preview.brackets.map((b) => b.stage)).toEqual(['main']);
    expect(preview.waitingStages.map((b) => [b.stage, b.waiting.map((q) => q.place)])).toEqual([
      ['consolation', [3, 4]],
    ]);
    state = run(state, draw(preview));
    const original = structuredClone(state.brackets[0]);
    state = run(state, {
      kind: 'placements',
      poolId: pool.id,
      expectedRevision: state.pools[0]!.revision,
      matchRevisions: Object.fromEntries(
        state.matches.filter((m) => m.poolId === pool.id).map((m) => [m.id, m.revision]),
      ),
      order: pool.entrantIds,
    });
    state = run(state, draw(previewStrengthFinals(state)));
    expect(state.brackets[0]).toEqual(original);
    expect(state.brackets.map((b) => b.stage)).toEqual(['main', 'consolation']);
  });

  it('leaves a division unfrozen when only its empty consolation is ready', () => {
    const baseline = pureBaseline();
    baseline.settings.poolOrderPolicy = 'unique_set_wins_v1';
    baseline.settings.finalsProgression = 'rolling_pool_places_v1';
    const upper = baseline.pools[0]!;
    upper.entrantIds = upper.entrantIds.slice(0, 2);
    baseline.entrants = baseline.entrants.filter(
      (entrant) => entrant.division === 'lower' || upper.entrantIds.includes(entrant.playerId),
    );
    baseline.matches = baseline.matches.filter(
      (match) =>
        match.division === 'lower' ||
        (upper.entrantIds.includes(match.player1Id!) &&
          upper.entrantIds.includes(match.player2Id!)),
    );
    let state = finish(captureBaseline(baseline), 'lower');
    const preview = previewStrengthFinals(state);
    expect(preview.brackets.map((b) => b.division)).toEqual(['lower', 'lower']);
    expect(preview.waitingStages.map((b) => [b.division, b.stage])).toEqual([['upper', 'main']]);
    state = run(state, draw(preview));
    expect(state.pools[0]!.qualifierRoster).toBeUndefined();
    state = finish(state, 'upper');
    expect(
      previewStrengthFinals(state).brackets.filter((b) => b.division === 'upper'),
    ).toHaveLength(2);
  });

  it('invalidates a ready preview when a selected pool result goes into review', () => {
    let state = finish(initial(), 'upper');
    const preview = previewStrengthFinals(state);
    const match = state.matches.find((m) => m.division === 'upper')!;
    state = reduceDecision(
      state,
      Decision.parse(
        decide(
          state,
          envelope(score(match, true), { operator: false, actorId: match.player2Id! }),
        )!,
      ),
    );
    const waiting = previewStrengthFinals(state);
    expect(waiting.allowed).toBe(false);
    expect(waiting.waitingStages.filter((b) => b.division === 'upper')).toHaveLength(2);
    expect(waiting.waitingStages[0]?.waiting[0]?.status).toBe('review_pending');
    expect(() => run(state, draw(preview))).toThrow(/preview/);
  });

  it('protects the actual frozen division while the other division can adjust its roster', () => {
    let state = finish(initial(), 'upper');
    state = run(state, draw(previewStrengthFinals(state)));
    const upper = state.pools[0]!.entrantIds[0]!;
    const lower = state.pools[1]!.entrantIds[0]!;
    expect(
      attendancePreview(state, { action: 'no_show', playerId: upper, division: 'lower' }),
    ).toMatchObject({
      division: 'upper',
      allowed: false,
      issues: expect.arrayContaining(['Remove unplayed finals before changing the pool draw.']),
    });
    const withdrawal = { action: 'withdraw', playerId: lower } as const;
    state = run(state, {
      kind: 'attendance',
      ...withdrawal,
      revisionToken: attendancePreview(state, withdrawal).revisionToken,
      approveRedistribution: false,
      reason: '',
    });
    expect(
      attendancePreview(state, { action: 'restore', playerId: lower, reason: 'Returned' })
        .restoration?.qualification.status,
    ).toBe('unfrozen');
    expect(
      attendancePreview(state, { action: 'add', playerId: stableId('late'), division: 'lower' })
        .allowed,
    ).toBe(true);
  });

  it('keeps old pool-place finals and combined strength draws from mixing', () => {
    const state = run(initial(), { kind: 'drawFinals' });
    expect(() => run(state, draw(previewStrengthFinals(state)))).toThrow(/existing finals policy/);
  });

  it('keeps a drawn bracket’s seeding on the journal until an explicit reset', () => {
    let state = finish(initial(), 'upper');
    state = run(state, draw(previewStrengthFinals(state)));
    const reset = previewStrengthFinals(state);
    expect(reset.resetAllowed).toBe(true);
    state = run(state, { kind: 'resetFinals', revisionToken: reset.resetRevisionToken });
    expect(state.brackets).toHaveLength(0);
    expect(state.pools.every((p) => !p.qualifierRoster)).toBe(true);
    expect(previewStrengthFinals(state).allowed).toBe(true);
  });
});
