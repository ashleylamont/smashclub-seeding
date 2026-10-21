import type { trpc } from '../../../lib/trpc';

export type ProjectionResult = Awaited<
  ReturnType<typeof trpc.admin.eventPlanner.projectTournament.query>
>;
export type FormatProjection = ProjectionResult['formats'][number];
export type ProjectedMatch = FormatProjection['matches'][number];

export function duration(minutes: number): string {
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

/** Wall-clock labels use the chosen local start and preserve next-day offsets. */
export function projectedTime(start: string, offset: number): string {
  const [hours, minutes] = start.split(':').map(Number);
  const total = (hours ?? 0) * 60 + (minutes ?? 0) + offset;
  const day = Math.floor(total / 1440);
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}${day ? ` (+${day}d)` : ''}`;
}
