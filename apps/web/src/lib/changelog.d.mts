export const releaseGroupHeadings: readonly string[];
export function groupReleaseNotes(markdown: string): string;
export function formatChangelog(markdown: string): string;

export interface ChangelogRelease {
  version: string;
  anchor: string;
  highlights: string;
  notes: string;
}
export function readChangelog(markdown: string): { releases: ChangelogRelease[]; archive: string };
