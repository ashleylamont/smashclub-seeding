import { z } from 'zod';
import { tournamentStructures, type TournamentStructure } from '@smashclub/shared';
import { projectionGraph, type ProjectionMatch } from './projectionGraph';

export const projectionInput = z.object({
  entrantCount: z.number().int().min(2).max(128),
  stationCount: z.number().int().min(1).max(32),
  matchMinutes: z.number().int().min(1).max(60),
  turnaroundMinutes: z.number().int().min(0).max(30),
  restMinutes: z.number().int().min(0).max(30),
  transitionMinutes: z.number().int().min(0).max(60),
  upperSize: z.number().int().min(3).max(125).nullable().default(null),
});
export type ProjectionInput = z.infer<typeof projectionInput>;
export type ScheduledProjectionMatch = ProjectionMatch & {
  station: number | null;
  startMinute: number;
  endMinute: number;
};

/** Earliest-ready dispatch. Stations and shared pool entrants cannot overlap. */
function schedule(matches: ProjectionMatch[], options: ProjectionInput) {
  const stations = Array<number>(options.stationCount).fill(0);
  const resourceFree = new Map<string, number>();
  const completed = new Map<string, ScheduledProjectionMatch>();
  let poolEnd = 0;
  for (const stage of ['group', 'finals'] as const) {
    const pending = matches.filter((m) =>
      stage === 'group' ? m.stage === 'group' : m.stage !== 'group',
    );
    // Finalists are unknown pool-place tokens, so allow the last pool players
    // their recovery time even when the organiser chooses a shorter break.
    const gate =
      stage === 'finals' ? poolEnd + Math.max(options.transitionMinutes, options.restMinutes) : 0;
    while (pending.length) {
      const ready = pending
        .flatMap((match, index) => {
          if (!match.dependsOn.every((id) => completed.has(id))) return [];
          const dependencyEnd = Math.max(
            0,
            ...match.dependsOn.map((id) => {
              const parent = completed.get(id)!;
              return parent.endMinute + (parent.bye ? 0 : options.restMinutes);
            }),
          );
          const stationFree = match.bye ? 0 : Math.min(...stations);
          const entrantFree = match.bye
            ? 0
            : Math.max(0, ...match.resources.map((id) => resourceFree.get(id) ?? 0));
          return [{ match, index, start: Math.max(gate, dependencyEnd, stationFree, entrantFree) }];
        })
        .sort((a, b) => a.start - b.start || a.index - b.index);
      const next = ready[0];
      if (!next) throw new Error('Projection contains an unresolved dependency.');
      const { match, index, start } = next;
      const station = match.bye ? null : stations.indexOf(Math.min(...stations));
      const endMinute = start + (match.bye ? 0 : options.matchMinutes);
      completed.set(match.id, {
        ...match,
        station: station === null ? null : station + 1,
        startMinute: start,
        endMinute,
      });
      if (station !== null) {
        stations[station] = endMinute + options.turnaroundMinutes;
        for (const id of match.resources) resourceFree.set(id, endMinute + options.restMinutes);
      }
      pending.splice(index, 1);
      if (stage === 'group') poolEnd = Math.max(poolEnd, endMinute);
    }
  }
  const scheduled = [...completed.values()].sort(
    (a, b) => a.startMinute - b.startMinute || a.id.localeCompare(b.id),
  );
  return {
    matches: scheduled,
    poolEndMinute: poolEnd,
    totalMinutes: Math.max(0, ...scheduled.map((m) => m.endMinute)),
  };
}

function projectFormat(structure: TournamentStructure, options: ProjectionInput) {
  const graph = projectionGraph(structure, options.entrantCount, options.upperSize);
  const planned = schedule(graph.matches, options);
  const fast = schedule(graph.matches, {
    ...options,
    matchMinutes: Math.max(1, Math.floor(options.matchMinutes * 0.8)),
  });
  const slow = schedule(graph.matches, {
    ...options,
    matchMinutes: Math.ceil(options.matchMinutes * 1.25),
  });
  return {
    structure,
    issues: graph.issues,
    pools: graph.pools,
    brackets: graph.brackets,
    ...planned,
    fastMinutes: fast.totalMinutes,
    slowMinutes: slow.totalMinutes,
    setCount: graph.matches.filter((m) => !m.bye).length,
    byeCount: graph.matches.filter((m) => m.bye).length,
    minimumSets: graph.guaranteed.length ? Math.min(...graph.guaranteed) : 0,
    maximumGuaranteedSets: Math.max(0, ...graph.guaranteed),
  };
}

/** Read-only count simulation. It never saves a draw, chooses winners or reserves stations. */
export function projectTournament(raw: ProjectionInput) {
  const input = projectionInput.parse(raw);
  return { input, formats: tournamentStructures.map(({ value }) => projectFormat(value, input)) };
}
