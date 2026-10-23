import { z } from 'zod';
import {
  tournamentStructures,
  structureOptionsSchema,
  type TournamentStructure,
} from '@smashclub/shared';
import { projectionGraph, type ProjectionMatch } from './projectionGraph';
import { ProjectionReady } from './projectionReady';

export const projectionInput = z.object({
  structureOptions: structureOptionsSchema.optional(),
  entrantCount: z.number().int().min(2),
  stationCount: z.number().int().min(1).max(32),
  matchMinutes: z.number().int().min(1).max(60),
  turnaroundMinutes: z.number().int().min(0).max(30),
  restMinutes: z.number().int().min(0).max(30),
  transitionMinutes: z.number().int().min(0).max(60),
  upperSize: z.number().int().min(3).nullable().default(null),
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
      stage === 'finals' && matches.some((m) => m.stage === 'group')
        ? poolEnd + Math.max(options.transitionMinutes, options.restMinutes)
        : 0;
    const played = new ProjectionReady(pending.length),
      byes = new ProjectionReady(pending.length);
    const indexById = new Map(pending.map((m, i) => [m.id, i]));
    const children = new Map<string, number[]>();
    const entrantReady = (match: ProjectionMatch) => {
      let start = gate;
      for (const id of match.dependsOn) {
        const parent = completed.get(id)!;
        start = Math.max(start, parent.endMinute + (parent.bye ? 0 : options.restMinutes));
      }
      if (!match.bye)
        for (const id of match.resources) start = Math.max(start, resourceFree.get(id) ?? 0);
      return start;
    };
    const activate = (index: number) => {
      const match = pending[index]!;
      if (match.dependsOn.every((id) => completed.has(id)))
        (match.bye ? byes : played).set(index, entrantReady(match));
    };
    for (const match of pending) {
      const index = indexById.get(match.id)!;
      for (const parent of match.dependsOn) {
        const list = children.get(parent) ?? [];
        list.push(index);
        children.set(parent, list);
      }
      activate(index);
    }
    let remaining = pending.length;
    while (remaining) {
      const earliestStation = Math.min(...stations);
      const start = Math.min(byes.earliest, Math.max(earliestStation, played.earliest));
      const index = Math.min(byes.firstAt(start) ?? Infinity, played.firstAt(start) ?? Infinity);
      if (!Number.isFinite(index)) throw new Error('Projection contains an unresolved dependency.');
      const match = pending[index]!;
      const ready = match.bye ? byes : played;
      const actualStart = Math.max(entrantReady(match), match.bye ? 0 : earliestStation);
      // Availability only moves later. Refresh a stale lower bound lazily;
      // unrelated matches and changes to the common station clock need no scan.
      if (actualStart > start) {
        ready.set(index, actualStart);
        continue;
      }
      ready.set(index, Infinity);
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
      remaining--;
      for (const child of children.get(match.id) ?? []) activate(child);
      if (stage === 'group') poolEnd = Math.max(poolEnd, endMinute);
    }
  }
  const scheduled = [...completed.values()].sort(
    (a, b) => a.startMinute - b.startMinute || a.id.localeCompare(b.id),
  );
  return {
    matches: scheduled,
    poolEndMinute: poolEnd,
    totalMinutes: scheduled.reduce((end, m) => Math.max(end, m.endMinute), 0),
  };
}

function projectFormat(structure: TournamentStructure, options: ProjectionInput) {
  const graph = projectionGraph(
    structure,
    options.entrantCount,
    options.upperSize,
    options.structureOptions,
  );
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
    conditionalSetCount: graph.matches.filter((m) => !m.bye && m.conditional).length,
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
