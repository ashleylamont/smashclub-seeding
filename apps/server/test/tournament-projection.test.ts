import { describe, expect, it } from 'vitest';
import { tournamentStructures, isKnockout } from '@smashclub/shared';
import {
  projectTournament,
  projectionInput,
  type ProjectionInput,
} from '../src/event-planner/projection';
import { projectionGraph } from '../src/event-planner/projectionGraph';
import { drawFinals } from '../src/tournament/brackets';
import { captureBaseline } from '../src/tournament/domain';
import { envelope, pureBaseline, nativeAdmin } from './helpers/nativeLiveFixture';
import { eventPlannerRouter } from '../src/trpc/routers/eventPlanner';
import type { TrpcContext } from '../src/trpc/trpc';

const options: ProjectionInput = {
  entrantCount: 16,
  stationCount: 4,
  matchMinutes: 10,
  turnaroundMinutes: 2,
  restMinutes: 2,
  transitionMinutes: 10,
  upperSize: null,
};
const project = (patch: Partial<ProjectionInput> = {}) =>
  projectTournament({ ...options, ...patch });

function assertSchedule(
  format: ReturnType<typeof project>['formats'][number],
  stationCount: number,
) {
  const played = format.matches.filter((m) => !m.bye);
  const byId = new Map(format.matches.map((m) => [m.id, m]));
  expect(new Set(format.matches.map((m) => m.id)).size).toBe(format.matches.length);
  const pairings = played
    .filter((m) => m.stage === 'group')
    .map((m) => [...m.sides].sort().join('|'));
  expect(new Set(pairings).size).toBe(pairings.length);
  expect(format.fastMinutes).toBeLessThanOrEqual(format.totalMinutes);
  expect(format.slowMinutes).toBeGreaterThanOrEqual(format.totalMinutes);
  for (const match of played) {
    expect(match.station).toBeGreaterThanOrEqual(1);
    expect(match.station).toBeLessThanOrEqual(stationCount);
    expect(match.endMinute - match.startMinute).toBe(options.matchMinutes);

    for (const id of match.dependsOn) {
      const feeder = byId.get(id)!;
      expect(match.startMinute).toBeGreaterThanOrEqual(feeder.endMinute + (feeder.bye ? 0 : 3));
    }
  }
  for (const match of played.filter((m) => m.stage !== 'group'))
    expect(match.startMinute).toBeGreaterThanOrEqual(
      format.poolEndMinute + (format.pools.length ? 3 : 0),
    );
  const stationFree = new Map<number, number>(),
    entrantFree = new Map<string, number>();
  for (const match of played) {
    expect(match.startMinute).toBeGreaterThanOrEqual(stationFree.get(match.station!) ?? 0);
    stationFree.set(match.station!, match.endMinute + options.turnaroundMinutes);
    for (const id of match.resources) {
      expect(match.startMinute).toBeGreaterThanOrEqual(entrantFree.get(id) ?? 0);
      entrantFree.set(id, match.endMinute + 3);
    }
  }
  for (const pool of format.pools) {
    expect(played.filter((m) => m.section === pool.id)).toHaveLength(
      (pool.entrants.length * (pool.entrants.length - 1)) / 2,
    );
  }
  for (const bracket of format.brackets) {
    expect(played.filter((m) => m.section === bracket.id)).toHaveLength(
      bracket.kind === 'double_elimination'
        ? 2 * bracket.entrants - 1
        : Math.max(0, bracket.entrants - 1),
    );
  }
}

describe('draft tournament projections', () => {
  it('has hand-checkable round robins and does not charge for idle stations or a final turnaround', () => {
    const two = project({ entrantCount: 2 }).formats[0]!;
    expect(two.setCount).toBe(1);
    expect(two.totalMinutes).toBe(10);
    expect(two.minimumSets).toBe(1);
    const four = project({ entrantCount: 4, stationCount: 32 }).formats[0]!;
    expect(four.setCount).toBe(6);
    expect(four.totalMinutes).toBe(34); // Three rounds, two recovery/turnaround intervals.
    expect(four.minimumSets).toBe(3);
    const odd = project({ entrantCount: 5, stationCount: 2, restMinutes: 0, turnaroundMinutes: 0 })
      .formats[0]!;
    expect(odd.setCount).toBe(10);
    expect(odd.totalMinutes).toBe(50);
  });

  it('counts Upper/Lower finals and distinguishes automatic byes from played sets', () => {
    const sixteen = project().formats[2]!;
    expect(sixteen.pools.map((p) => p.entrants.length)).toEqual([4, 4, 4, 4]);
    expect(sixteen.brackets.map((b) => b.entrants)).toEqual([4, 4, 4, 4]);
    expect(sixteen.setCount).toBe(36); // 24 pool sets + four 3-set brackets.
    expect(sixteen.minimumSets).toBe(4);
    const six = project({ entrantCount: 6 }).formats[2]!;
    expect(six.setCount).toBe(8); // Two 3-player round robins and two championships.
    expect(six.byeCount).toBe(2); // One consolation qualifier in each division.
    expect(six.minimumSets).toBe(2);
    for (const bye of six.matches.filter((m) => m.bye)) {
      expect(bye.station).toBeNull();
      expect(bye.startMinute).toBe(bye.endMinute);
    }
  });

  it('uses the actual uneven split and the same 3–5 entrant pool balancing as the planner', () => {
    const result = project({ entrantCount: 17, upperSize: 10 }).formats[2]!;
    expect(result.pools.map((p) => p.entrants.length)).toEqual([3, 3, 4, 3, 4]);
    expect(result.brackets.map((b) => b.entrants)).toEqual([6, 4, 4, 3]);
    expect(project({ entrantCount: 8, upperSize: 6 }).formats[2]!.issues).toContain(
      'Each division needs at least three entrants; adjust the Upper size.',
    );
  });

  it('shows unsupported format/count combinations without inventing a bracket', () => {
    for (const count of [2, 3, 5, 6, 8, 9, 128]) {
      const result = project({ entrantCount: count });
      for (const format of result.formats) {
        if (!format.issues.length) continue;
        expect(format.matches).toEqual([]);
        expect(format.totalMinutes).toBe(0);
      }
    }
    expect(project({ entrantCount: 9 }).formats[0]!.issues).toEqual([]);
  });

  it('respects station capacity, entrants, feeder matches and stage/recovery breaks across the field', () => {
    expect.hasAssertions();
    for (const count of [2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 17, 24, 33, 64, 128]) {
      for (const stationCount of [1, 3, 8, 32]) {
        const result = project({
          entrantCount: count,
          stationCount,
          transitionMinutes: 0,
          restMinutes: 3,
        });
        for (const format of result.formats.filter((f) => !f.issues.length)) {
          assertSchedule(format, stationCount);
        }
      }
    }
  }, 30_000);

  it('provides sensible time changes for stations, longer sets and the finals break', () => {
    const one = project({ stationCount: 1 }).formats[2]!;
    const eight = project({ stationCount: 8 }).formats[2]!;
    expect(eight.totalMinutes).toBeLessThan(one.totalMinutes);
    expect(project({ matchMinutes: 15 }).formats[2]!.totalMinutes).toBeGreaterThan(
      project().formats[2]!.totalMinutes,
    );
    expect(
      project({ transitionMinutes: 20 }).formats[2]!.totalMinutes -
        project({ transitionMinutes: 10 }).formats[2]!.totalMinutes,
    ).toBe(10);
    expect(project()).toEqual(project());
  });

  it('matches native finals counts, byes and first-round pairings for odd and even fields', () => {
    for (const count of [3, 5, 6, 7, 8, 9, 11, 12, 13, 17, 24, 33]) {
      for (const { value: structure } of tournamentStructures.filter(
        (s) => s.value !== 'round_robin' && !isKnockout(s.value),
      )) {
        const graph = projectionGraph(structure, count, null);
        if (graph.issues.length) continue;
        const baseline = pureBaseline();
        baseline.version = 2;
        baseline.structure = structure;
        baseline.competitionFormat = 'doubles'; // Team IDs have identical scheduling semantics.
        baseline.matches = [];
        baseline.entrants = [];
        baseline.pools = graph.pools.map((pool) => {
          const template = pureBaseline().pools[0]!;
          const divisionPools = graph.pools.filter((p) => p.id[0] === pool.id[0]);
          const index = divisionPools.indexOf(pool);
          const order = pool.entrants.map((_, i) => `${pool.id.replace('-P', '')}${i + 1}`);
          return {
            ...template,
            id: pool.id,
            division: pool.id[0] === 'L' ? 'lower' : 'upper',
            index,
            entrantIds: order,
            order,
          };
        });
        const entrantTemplate = pureBaseline().entrants[0]!;
        const matchTemplate = pureBaseline().matches[0]!;
        baseline.entrants = baseline.pools.flatMap((pool) =>
          pool.entrantIds.map((id, i) => ({
            ...entrantTemplate,
            id,
            playerId: id,
            name: id,
            division: pool.division,
            seed: i + 1,
            memberPlayerIds: [`${id}:a`, `${id}:b`],
          })),
        );
        baseline.matches = baseline.pools.flatMap((pool) =>
          pool.entrantIds.flatMap((a, i) =>
            pool.entrantIds.slice(i + 1).map((b) => ({
              ...matchTemplate,
              id: `${a}:${b}`,
              poolId: pool.id,
              division: pool.division,
              player1Id: a,
              player2Id: b,
            })),
          ),
        );
        const state = captureBaseline(baseline);
        for (const match of state.matches)
          Object.assign(match, {
            status: 'complete',
            outcome: 'played',
            winnerId: match.player1Id,
          });
        drawFinals(state, envelope({ kind: 'drawFinals' }));
        for (const bracket of graph.brackets) {
          const division = bracket.id[0] === 'L' ? 'lower' : 'upper';
          const stage = bracket.id[1] === 'M' ? 'main' : 'consolation';
          const actual = state.matches.filter((m) => m.division === division && m.stage === stage);
          const expected = graph.matches.filter((m) => m.section === bracket.id);
          expect(actual).toHaveLength(expected.length);
          expect(actual.filter((m) => m.outcome === 'bye')).toHaveLength(
            expected.filter((m) => m.bye).length,
          );
          expect(
            actual
              .filter((m) => m.round === 1)
              .map((m) => [m.player1Id ?? 'Bye', m.player2Id ?? 'Bye']),
          ).toEqual(expected.filter((m) => m.round === 1).map((m) => m.sides));
        }
      }
    }
  });

  it('accepts round robins beyond the former preview ceiling', () => {
    const result = project({ entrantCount: 129 }).formats[0]!;
    expect(result.issues).toEqual([]);
    expect(result.setCount).toBe(8256);
    expect(result.minimumSets).toBe(128);
    expect(result.totalMinutes).toBeGreaterThan(0);
  });

  it('projects repeated round robins with the configured workload and guarantee', () => {
    const once = project({ entrantCount: 9 }).formats[0]!;
    const twice = project({ entrantCount: 9, structureOptions: { roundRobinMeetings: 2 } })
      .formats[0]!;
    expect(once.setCount).toBe(36);
    expect(twice.setCount).toBe(72);
    expect(twice.minimumSets).toBe(16);
    expect(twice.totalMinutes).toBeGreaterThan(once.totalMinutes);
    const pools = project({ entrantCount: 8, structureOptions: { roundRobinMeetings: 2 } })
      .formats[1]!;
    expect(pools.matches.filter((m) => m.stage === 'group')).toHaveLength(24);
    expect(pools.brackets.map((b) => b.entrants)).toEqual([4, 4]);
  });

  it('rejects fractional counts, invalid variants and invalid timing input', () => {
    for (const patch of [
      { entrantCount: 1 },
      { stationCount: 0 },
      { stationCount: 33 },
      { stationCount: 2.5 },
      { matchMinutes: 0 },
      { restMinutes: -1 },
      { upperSize: 2 },
      { turnaroundMinutes: 31 },
      { structureOptions: { roundRobinMeetings: 0 } },
    ])
      expect(() => projectionInput.parse({ ...options, ...patch })).toThrow(
        /Too (small|big)|Invalid input/,
      );
  });

  it('ships an admin-only query that requires no database or mutation', async () => {
    const context = { user: nativeAdmin } as TrpcContext;
    expect(await eventPlannerRouter.createCaller(context).projectTournament(options)).toEqual(
      project(),
    );
    await expect(
      eventPlannerRouter.createCaller({ ...context, user: null }).projectTournament(options),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      eventPlannerRouter
        .createCaller({ ...context, user: { ...nativeAdmin, role: 'user' } })
        .projectTournament(options),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
