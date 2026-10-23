import { buildEliminationTree } from './elimination';
import { buildDoubleEliminationTree } from './doubleElimination';
import {
  structureIssues,
  tournamentStructureSchema,
  isKnockout,
  isSinglePool,
  finalsRoles,
  structureOptionsSchema,
  type StructureOptions,
  type TournamentStructure,
} from '@smashclub/shared';
import { stripeIntoPools } from './pools';
import {
  championshipQualifiers,
  consolationQualifiers,
  seedPoolFinishers,
  winnersCount,
  type PoolFinisher,
} from './advancement';

/** Sources are data, never display labels or predicted winners. */
export type TournamentSlot =
  | { kind: 'entrant'; entrantId: string }
  | { kind: 'pool_place'; poolId: string; place: number }
  | { kind: 'winner'; matchId: string }
  | { kind: 'loser'; matchId: string }
  | { kind: 'bye' };

export interface StructureMatch {
  id: string;
  stageId: string;
  round: number;
  slot: number;
  /** One-based repetition of a round robin; absent for elimination. */
  meeting?: number;
  bracketLane?: 'winners' | 'losers' | 'final' | 'reset';
  bracketRound?: number;
  activation?: { matchId: string; winnerSide: 1 | 2 };
  sides: [TournamentSlot, TournamentSlot];
  dependsOn: string[];
}

export interface PoolStage {
  kind: 'round_robin';
  id: string;
  divisionId: string;
  index: number;
  entrantIds: string[];
  championship: number;
  consolation: number;
  dependsOn: string[];
}

export interface FinalsStage {
  kind: 'single_elimination' | 'double_elimination';
  id: string;
  divisionId: string;
  role: 'main' | 'consolation';
  entrants: TournamentSlot[];
  dependsOn: string[];
}

export interface TournamentGraph {
  version: 1;
  options: StructureOptions;
  stages: (PoolStage | FinalsStage)[];
  /** A stable topological order; independent matches need not run sequentially. */
  matches: StructureMatch[];
  guaranteedSets: { source: TournamentSlot; count: number }[];
}

/** Circle rounds: every pair once per meeting, alternating sides on return meetings. */
export function buildRoundRobin(entrantIds: readonly string[], meetings = 1) {
  if (!Number.isSafeInteger(meetings) || meetings < 1)
    throw new Error('Round-robin meetings must be a positive integer.');
  if (new Set(entrantIds).size !== entrantIds.length)
    throw new Error('A round robin cannot contain duplicate entrants.');
  const matches: {
    round: number;
    slot: number;
    meeting: number;
    player1Id: string;
    player2Id: string;
  }[] = [];
  if (entrantIds.length < 2) return matches;
  for (let meeting = 1; meeting <= meetings; meeting++) {
    const ring: (string | null)[] = [...entrantIds];
    if (ring.length % 2) ring.push(null);
    for (let round = 1; round < ring.length; round++) {
      for (let slot = 0; slot < ring.length / 2; slot++) {
        const a = ring[slot],
          b = ring[ring.length - slot - 1];
        if (a === null || b === null) continue;
        matches.push({
          round: (meeting - 1) * (ring.length - 1) + round,
          slot,
          meeting,
          player1Id: meeting % 2 ? a! : b!,
          player2Id: meeting % 2 ? b! : a!,
        });
      }
      ring.splice(1, 0, ring.pop()!);
    }
  }
  return matches;
}

/** The same qualification and rematch repair for actual finishers and symbolic pool places. */
export function buildPoolFinals(finishers: readonly PoolFinisher[], role: 'main' | 'consolation') {
  const qualifiers =
    role === 'main' ? championshipQualifiers(finishers) : consolationQualifiers(finishers);
  return qualifiers.length ? seedPoolFinishers(qualifiers).entrants : [];
}

/** Qualification policy shared by symbolic compilation, live finals and planner views. */
export function buildFormatFinals(
  structure: TournamentStructure | undefined,
  finishers: readonly PoolFinisher[],
  role: 'main' | 'consolation',
  options?: Partial<StructureOptions>,
) {
  if (!finalsRoles(structure, options).includes(role)) return [];
  if (structure !== 'round_robin_finals') return buildPoolFinals(finishers, role);
  const cut = options?.playoffSize ?? finishers.length;
  const selected = finishers.filter((f) => (role === 'main' ? f.place <= cut : f.place > cut));
  return selected.length ? seedPoolFinishers(selected).entrants : [];
}

/**
 * Compile ranked entrants into a serializable structure, without storage, UI,
 * stations, clocks, ratings, or scoring. Division membership is an input: pins
 * and frozen seeds belong to roster policy, not to a format generator.
 */
export function compileTournament(input: {
  structure: TournamentStructure;
  divisions: readonly { id: string; entrantIds: readonly string[] }[];
  options?: Partial<StructureOptions>;
  poolSize?: number;
}): TournamentGraph {
  const structure = tournamentStructureSchema.parse(input.structure);
  const options = structureOptionsSchema.parse(input.options ?? {});
  const entrantIds = input.divisions.flatMap((d) => [...d.entrantIds]);
  const issues = structureIssues(structure, entrantIds.length, options);
  if (issues.length) throw new Error(issues.join(' '));
  if (input.divisions.length !== (structure === 'dual_division' ? 2 : 1))
    throw new Error('Division count does not match the tournament structure.');
  if (
    new Set(input.divisions.map((d) => d.id)).size !== input.divisions.length ||
    new Set(entrantIds).size !== entrantIds.length
  )
    throw new Error('Division and entrant IDs must be unique.');
  const graph: TournamentGraph = {
    version: 1,
    options,
    stages: [],
    matches: [],
    guaranteedSets: [],
  };
  if (isKnockout(structure)) {
    const division = input.divisions[0]!;
    const stage: FinalsStage = {
      kind: structure === 'double_elimination' ? 'double_elimination' : 'single_elimination',
      id: `${division.id}:main`,
      divisionId: division.id,
      role: 'main',
      entrants: entrantIds.map((entrantId) => ({ kind: 'entrant', entrantId })),
      dependsOn: [],
    };
    graph.stages.push(stage);
    graph.matches = (
      stage.kind === 'double_elimination' ? buildDoubleEliminationTree : buildEliminationTree
    )(stage.id, stage.entrants);
    graph.guaranteedSets = stage.entrants.map((source) => ({
      source,
      count: stage.kind === 'double_elimination' ? 2 : 1,
    }));
    return graph;
  }
  const poolStages: PoolStage[] = [];
  for (const division of input.divisions) {
    const groups = isSinglePool(structure)
      ? [[...division.entrantIds]]
      : stripeIntoPools(division.entrantIds, input.poolSize);
    for (const [index, entrantIds] of groups.entries()) {
      const championship =
        structure === 'round_robin'
          ? 0
          : structure === 'round_robin_finals'
            ? Math.min(entrantIds.length, options.playoffSize ?? entrantIds.length)
            : winnersCount(entrantIds.length);
      const pool: PoolStage = {
        kind: 'round_robin',
        id: `${division.id}:pool:${index}`,
        divisionId: division.id,
        index,
        entrantIds,
        championship,
        consolation:
          structure === 'round_robin' || !finalsRoles(structure, options).includes('consolation')
            ? 0
            : entrantIds.length - championship,
        dependsOn: [],
      };
      poolStages.push(pool);
      graph.stages.push(pool);
    }
  }
  for (const pool of poolStages) {
    for (const m of buildRoundRobin(pool.entrantIds, options.roundRobinMeetings))
      graph.matches.push({
        id: `${pool.id}:${m.round}:${m.slot}`,
        stageId: pool.id,
        round: m.round,
        slot: m.slot,
        meeting: m.meeting,
        sides: [
          { kind: 'entrant', entrantId: m.player1Id },
          { kind: 'entrant', entrantId: m.player2Id },
        ],
        dependsOn: [],
      });
    if (structure === 'round_robin')
      for (const entrantId of pool.entrantIds)
        graph.guaranteedSets.push({
          source: { kind: 'entrant', entrantId },
          count: (pool.entrantIds.length - 1) * options.roundRobinMeetings,
        });
  }
  graph.matches.sort((a, b) => a.round - b.round || a.slot - b.slot);
  if (structure === 'round_robin') return graph;
  for (const division of input.divisions) {
    const pools = poolStages.filter((p) => p.divisionId === division.id);
    const sources = new Map<string, TournamentSlot>();
    const finishers = pools.flatMap((p) =>
      p.entrantIds.map((_, i) => {
        const playerId = `${p.id}:place:${i + 1}`;
        sources.set(playerId, { kind: 'pool_place', poolId: p.id, place: i + 1 });
        return { playerId, poolIndex: p.index, place: i + 1 };
      }),
    );
    for (const role of finalsRoles(structure, options)) {
      const qualifiers = buildFormatFinals(structure, finishers, role, options);
      const stage: FinalsStage = {
        kind: 'single_elimination',
        id: `${division.id}:${role}`,
        divisionId: division.id,
        role,
        entrants: qualifiers.map((q) => sources.get(q.playerId)!),
        dependsOn: poolStages.map((p) => p.id),
      };
      graph.stages.push(stage);
      graph.matches.push(...buildEliminationTree(stage.id, stage.entrants));
      for (const q of qualifiers)
        graph.guaranteedSets.push({
          source: sources.get(q.playerId)!,
          count:
            (pools.find((p) => p.index === q.poolIndex)!.entrantIds.length - 1) *
              options.roundRobinMeetings +
            Number(qualifiers.length >= 2),
        });
    }
  }
  const represented = new Set(graph.guaranteedSets.map((s) => JSON.stringify(s.source)));
  for (const pool of poolStages)
    for (let place = 1; place <= pool.entrantIds.length; place++) {
      const source: TournamentSlot = { kind: 'pool_place', poolId: pool.id, place };
      if (!represented.has(JSON.stringify(source)))
        graph.guaranteedSets.push({
          source,
          count: (pool.entrantIds.length - 1) * options.roundRobinMeetings,
        });
    }
  return graph;
}

export { buildEliminationTree } from './elimination';
