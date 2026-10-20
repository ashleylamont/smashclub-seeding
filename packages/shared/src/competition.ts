export type CompetitionFormat = 'singles' | 'doubles';
export type TournamentStructure = 'round_robin' | 'pools_finals' | 'dual_division';

export const tournamentStructures = [
  {
    value: 'round_robin',
    label: 'Open round robin',
    description:
      'One pool; confirmed finishing order decides the event. Recommended for 2–5 teams.',
  },
  {
    value: 'pools_finals',
    label: 'Open pools and finals',
    description: 'Balanced pools, then championship and consolation. Recommended for 6–11 teams.',
  },
  {
    value: 'dual_division',
    label: 'Upper / Lower pools and finals',
    description:
      'Two seeded divisions, each with championship and consolation. Recommended for 12 or more teams.',
  },
] as const;

export function recommendedStructure(entrants: number): TournamentStructure {
  return entrants <= 5 ? 'round_robin' : entrants < 12 ? 'pools_finals' : 'dual_division';
}

export function structureIssues(structure: TournamentStructure, entrants: number): string[] {
  if (!Number.isInteger(entrants) || entrants < 2) return ['At least two entrants are required.'];
  if (structure === 'round_robin' && entrants > 8)
    return ['A single round robin supports at most eight entrants; choose pools and finals.'];
  if (structure === 'dual_division' && entrants < 6)
    return ['Two divisions require at least six entrants.'];
  if (structure === 'pools_finals' && entrants < 3)
    return ['Pools and finals require at least three entrants.'];
  return [];
}
