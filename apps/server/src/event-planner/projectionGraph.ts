import {
  type StructureOptions,
  type TournamentStructure,
  structureIssues,
} from '@smashclub/shared';
import { compileTournament, poolLabel, type TournamentSlot } from '@smashclub/engine';

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
  conditional?: boolean;
}
export interface ProjectionPool {
  id: string;
  label: string;
  entrants: string[];
  championship: number;
  consolation: number;
  setCount?: number;
}
export interface ProjectionBracket {
  id: string;
  label: string;
  entrants: number;
  matchIds: string[];
  kind?: 'single_elimination' | 'double_elimination';
}

/** Presentation adapter for a count-based rehearsal of the pure tournament graph. */
export function projectionGraph(
  structure: TournamentStructure,
  count: number,
  upperSize: number | null,
  options?: Partial<StructureOptions>,
) {
  const issues = structureIssues(structure, count, options);
  const upper = upperSize ?? Math.ceil(count / 2);
  if (structure === 'dual_division' && (!Number.isInteger(upper) || upper < 3 || count - upper < 3))
    issues.push('Each division needs at least three entrants; adjust the Upper size.');
  const pools: ProjectionPool[] = [],
    brackets: ProjectionBracket[] = [],
    matches: ProjectionMatch[] = [];
  if (issues.length) return { issues, pools, brackets, matches, guaranteed: [] as number[] };
  const divisions =
    structure === 'dual_division'
      ? [
          { id: 'U', label: 'Upper', count: upper },
          { id: 'L', label: 'Lower', count: count - upper },
        ]
      : [{ id: 'O', label: 'Open', count }];
  const graph = compileTournament({
    structure,
    options,
    divisions: divisions.map((d) => ({
      id: d.id,
      entrantIds: Array.from({ length: d.count }, (_, i) => `${d.id} seed ${i + 1}`),
    })),
  });
  const stageViews = new Map(
    graph.stages.map((stage) => {
      const division = divisions.find((d) => d.id === stage.divisionId)!;
      return [
        stage.id,
        stage.kind === 'round_robin'
          ? {
              id: `${division.id}-P${poolLabel(stage.index)}`,
              label: `${division.label} pool ${poolLabel(stage.index)}`,
              stage: 'group' as const,
            }
          : {
              id: `${division.id}${stage.role === 'main' ? 'M' : 'C'}`,
              label: `${division.label} ${stage.role === 'main' ? 'championship' : 'consolation'}`,
              stage: stage.role,
            },
      ];
    }),
  );
  const matchIds = new Map(
    graph.matches.map((m) => [m.id, `${stageViews.get(m.stageId)!.id}-${m.round}-${m.slot + 1}`]),
  );
  const labelSlot = (source: TournamentSlot): string => {
    switch (source.kind) {
      case 'entrant':
        return source.entrantId;
      case 'pool_place': {
        const pool = graph.stages.find((s) => s.id === source.poolId)!;
        return pool.kind === 'round_robin'
          ? `${pool.divisionId}${poolLabel(pool.index)}${source.place}`
          : '';
      }
      case 'winner':
        return `Winner ${matchIds.get(source.matchId)!}`;
      case 'loser':
        return `Loser ${matchIds.get(source.matchId)!}`;
      case 'bye':
        return 'Bye';
    }
  };
  const resources = new Map<string, string[]>();
  const loserResources = new Map<string, string[]>();
  for (const match of graph.matches) {
    const view = stageViews.get(match.stageId)!;
    const sideResources = match.sides.map((s) =>
      s.kind === 'bye'
        ? []
        : s.kind === 'winner'
          ? resources.get(s.matchId)!
          : s.kind === 'loser'
            ? loserResources.get(s.matchId)!
            : [labelSlot(s)],
    );
    const possible = [...new Set(sideResources.flat())];
    resources.set(match.id, possible);
    loserResources.set(match.id, sideResources.every((r) => r.length) ? possible : []);
    matches.push({
      id: matchIds.get(match.id)!,
      label: `${view.label} · ${match.bracketLane ?? 'R'}${match.bracketRound ?? match.round} M${match.slot + 1}${match.activation ? ' (if needed)' : ''}`,
      stage: view.stage,
      section: view.id,
      round: match.round,
      slot: match.slot,
      sides: match.sides.map(labelSlot) as [string, string],
      resources: possible,
      dependsOn: match.dependsOn.map((id) => matchIds.get(id)!),
      bye: sideResources.some((r) => r.length === 0),
      ...(match.activation ? { conditional: true } : {}),
    });
  }
  for (const stage of graph.stages) {
    const view = stageViews.get(stage.id)!;
    if (stage.kind === 'round_robin')
      pools.push({
        id: view.id,
        label: view.label,
        entrants: stage.entrantIds,
        championship: stage.championship,
        consolation: stage.consolation,
        setCount: matches.filter((m) => m.section === view.id && !m.bye).length,
      });
    else
      brackets.push({
        id: view.id,
        label: view.label,
        entrants: stage.entrants.length,
        kind: stage.kind,
        matchIds: matches.filter((m) => m.section === view.id).map((m) => m.id),
      });
  }
  return { issues, pools, brackets, matches, guaranteed: graph.guaranteedSets.map((s) => s.count) };
}
