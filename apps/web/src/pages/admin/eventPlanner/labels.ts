/**
 * Planner vocabulary, in the words an organiser uses.
 *
 * Separate from `shared.tsx` because that file exports components and this one
 * exports constants; keeping them apart is what lets fast refresh work on the
 * components.
 */

export const DIVISION_LABEL = { upper: 'Upper', lower: 'Lower' } as const;

/** `event_plan_status`, spelled out. Unknown values print through unchanged. */
export const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  roster_frozen: 'Roster frozen',
  pools_ready: 'Pools ready',
  underway: 'Underway',
  complete: 'Complete',
  cancelled: 'Cancelled',
};
