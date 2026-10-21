import { type TournamentStructure, structureIssues } from '@smashclub/shared';
import { stripeIntoPools, poolLabel } from './pools';
import {
  buildConsolationBracket,
  championshipQualifiers,
  consolationQualifiers,
  standardBracketOrder,
  winnersCount,
} from './advancement';

export interface ProjectionMatch {
  id: string;
  label: string;
  stage: 'group' | 'main' | 'consolation';
  section: string;
  round: number;
  slot: number;
  sides: [string, string];
  /** Pool entrants, or possible finalists. No winner is predicted. */
  resources: string[];
  dependsOn: string[];
  bye: boolean;
}
export interface ProjectionPool {
  id: string;
  label: string;
  entrants: string[];
  championship: number;
  consolation: number;
}
export interface ProjectionBracket {
  id: string;
  label: string;
  entrants: number;
  matchIds: string[];
}

/** Circle rounds include every pairing once and omit the idle entrant in odd pools. */
function poolMatches(pool: ProjectionPool): ProjectionMatch[] {
  const ring: (string | null)[] = [...pool.entrants];
  if (ring.length % 2) ring.push(null);
  const matches: ProjectionMatch[] = [];
  for (let round = 1; round < ring.length; round++) {
    for (let slot = 0; slot < ring.length / 2; slot++) {
      const a = ring[slot],
        b = ring[ring.length - slot - 1];
      if (!a || !b) continue;
      matches.push({
        id: `${pool.id}-${matches.length + 1}`,
        label: `${pool.label} · round ${round}`,
        stage: 'group',
        section: pool.id,
        round,
        slot,
        sides: [a, b],
        resources: [a, b],
        dependsOn: [],
        bye: false,
      });
    }
    ring.splice(1, 0, ring.pop()!);
  }
  return matches;
}

function finalMatches(
  id: string,
  label: string,
  stage: 'main' | 'consolation',
  entrants: string[],
) {
  const matches: ProjectionMatch[] = [];
  if (!entrants.length) return matches;
  let size = 2;
  while (size < entrants.length) size *= 2;
  const slots = standardBracketOrder(size).map((seed) => entrants[seed - 1] ?? null);
  let previous: ProjectionMatch[] = [];
  for (let width = size / 2, round = 1; width >= 1; width /= 2, round++) {
    const current: ProjectionMatch[] = [];
    for (let slot = 0; slot < width; slot++) {
      const parents = round === 1 ? [] : previous.slice(slot * 2, slot * 2 + 2);
      const sides: [string, string] =
        round === 1
          ? [slots[slot * 2] ?? 'Bye', slots[slot * 2 + 1] ?? 'Bye']
          : [`Winner ${parents[0]!.id}`, `Winner ${parents[1]!.id}`];
      const resources =
        round === 1
          ? slots.slice(slot * 2, slot * 2 + 2).filter((s): s is string => s !== null)
          : parents.flatMap((p) => p.resources);
      current.push({
        id: `${id}-${round}-${slot + 1}`,
        label: `${label} · R${round} M${slot + 1}`,
        stage,
        section: id,
        round,
        slot,
        sides,
        resources,
        dependsOn: parents.map((p) => p.id),
        bye: resources.length < 2,
      });
    }
    matches.push(...current);
    previous = current;
  }
  return matches;
}

/** Count-based rehearsal using the same pool sizes, qualifiers and finals seeding as Nemesis. */
export function projectionGraph(
  structure: TournamentStructure,
  count: number,
  upperSize: number | null,
) {
  const issues = structureIssues(structure, count);
  const upper = upperSize ?? Math.ceil(count / 2);
  if (structure === 'dual_division' && (upper < 3 || count - upper < 3))
    issues.push('Each division needs at least three entrants; adjust the Upper size.');
  const pools: ProjectionPool[] = [],
    brackets: ProjectionBracket[] = [],
    matches: ProjectionMatch[] = [];
  const guaranteed: number[] = [];
  if (issues.length) return { issues, pools, brackets, matches, guaranteed };
  const divisions =
    structure === 'dual_division'
      ? [
          { id: 'U', label: 'Upper', count: upper },
          { id: 'L', label: 'Lower', count: count - upper },
        ]
      : [{ id: 'O', label: 'Open', count }];
  for (const division of divisions) {
    const seeds = Array.from({ length: division.count }, (_, i) => `${division.id} seed ${i + 1}`);
    const groups = structure === 'round_robin' ? [seeds] : stripeIntoPools(seeds);
    const divisionPools = groups.map((entrants, i) => ({
      id: `${division.id}-P${poolLabel(i)}`,
      label: `${division.label} pool ${poolLabel(i)}`,
      entrants,
      championship: structure === 'round_robin' ? 0 : winnersCount(entrants.length),
      consolation:
        structure === 'round_robin' ? 0 : entrants.length - winnersCount(entrants.length),
    }));
    pools.push(...divisionPools);
    matches.push(
      ...divisionPools.flatMap(poolMatches).sort((a, b) => a.round - b.round || a.slot - b.slot),
    );
    if (structure === 'round_robin') {
      guaranteed.push(count - 1);
      continue;
    }
    const finishers = groups.flatMap((group, poolIndex) =>
      group.map((_, i) => ({
        playerId: `${division.id}${poolLabel(poolIndex)}${i + 1}`,
        poolIndex,
        place: i + 1,
      })),
    );
    for (const stage of ['main', 'consolation'] as const) {
      const qualifiers =
        stage === 'main' ? championshipQualifiers(finishers) : consolationQualifiers(finishers);
      const drawInput =
        stage === 'main'
          ? qualifiers.map((q, index) => ({
              ...q,
              place:
                qualifiers.filter((p, i) => i < index && p.poolIndex === q.poolIndex).length + 3,
            }))
          : qualifiers;
      const entrants = drawInput.length
        ? buildConsolationBracket(drawInput).entrants.map((e) => e.playerId)
        : [];
      const id = `${division.id}${stage === 'main' ? 'M' : 'C'}`;
      const label = `${division.label} ${stage === 'main' ? 'championship' : 'consolation'}`;
      const drawn = finalMatches(id, label, stage, entrants);
      brackets.push({ id, label, entrants: entrants.length, matchIds: drawn.map((m) => m.id) });
      matches.push(...drawn);
      for (const q of qualifiers)
        guaranteed.push(groups[q.poolIndex]!.length - 1 + Number(entrants.length >= 2));
    }
  }
  return { issues, pools, brackets, matches, guaranteed };
}
