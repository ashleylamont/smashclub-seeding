import { z } from 'zod';

export type CompetitionFormat = 'singles' | 'doubles';
export const tournamentStructureSchema = z.enum([
  'round_robin',
  'round_robin_finals',
  'single_elimination',
  'double_elimination',
  'pools_finals',
  'dual_division',
]);
export type TournamentStructure = z.infer<typeof tournamentStructureSchema>;

/** Inputs to structure generation, independent of entrants, scoring and scheduling. */
export const structureOptionsSchema = z.object({
  roundRobinMeetings: z.number().int().positive().default(1),
  playoffSize: z.number().int().min(2).nullable().optional(),
  consolation: z.boolean().optional(),
});
export type StructureOptions = z.infer<typeof structureOptionsSchema>;

export const tournamentStructures = [
  {
    value: 'round_robin',
    label: 'Open round robin',
    description: 'One pool; confirmed finishing order decides the event.',
  },
  {
    value: 'pools_finals',
    label: 'Open pools and finals',
    description: 'Balanced pools, then championship and consolation.',
  },
  {
    value: 'dual_division',
    label: 'Upper / Lower pools and finals',
    description: 'Two seeded divisions, each with championship and consolation.',
  },
  {
    value: 'round_robin_finals',
    label: 'Round robin and playoffs',
    description: 'One round robin, then a configurable playoff cut and optional consolation.',
  },
  {
    value: 'single_elimination',
    label: 'Single elimination',
    description: 'A seeded knockout bracket; one loss eliminates an entrant.',
  },
  {
    value: 'double_elimination',
    label: 'Double elimination',
    description: 'Winners and losers brackets, with a reset final if needed.',
  },
] as const;

export const isKnockout = (structure?: string) =>
  structure === 'single_elimination' || structure === 'double_elimination';
export const isSinglePool = (structure?: string) =>
  structure === 'round_robin' || structure === 'round_robin_finals';
export function finalsRoles(
  structure: string | undefined,
  options?: Partial<StructureOptions>,
): ('main' | 'consolation')[] {
  if (isKnockout(structure) || structure === 'round_robin') return ['main'];
  return (options?.consolation ?? structure !== 'round_robin_finals')
    ? ['main', 'consolation']
    : ['main'];
}
export const expectedBracketCount = (
  structure: string | undefined,
  options?: Partial<StructureOptions>,
) => finalsRoles(structure, options).length * (structure === 'dual_division' || !structure ? 2 : 1);

export function structureIssues(
  structure: TournamentStructure,
  entrants: number,
  options?: Partial<StructureOptions>,
): string[] {
  if (!Number.isInteger(entrants) || entrants < 2) return ['At least two entrants are required.'];
  if (structure === 'round_robin_finals' && options?.playoffSize && options.playoffSize > entrants)
    return ['The playoff cut cannot exceed the entrant count.'];
  if (structure === 'dual_division' && entrants < 6)
    return ['Two divisions require at least six entrants.'];
  if (structure === 'pools_finals' && entrants < 3)
    return ['Pools and finals require at least three entrants.'];
  return [];
}
