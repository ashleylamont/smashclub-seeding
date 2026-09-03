import type { TournamentListItem } from './apiTypes';
import { bucketFor, type Bucket } from './tournamentBuckets';
import { compareEventBrackets, eventCanonicalSlug, eventNameOf } from '@smashclub/shared';

export interface TournamentEventGroup {
  key: string;
  slug: string;
  title: string;
  eventDate: string | null;
  items: TournamentListItem[];
  bucket: Bucket;
  live: boolean;
}

/** Group brackets by calendar event date; undated brackets remain singletons. */
export function groupTournamentsByEvent(items: TournamentListItem[], now: number): TournamentEventGroup[] {
  const grouped = new Map<string, TournamentListItem[]>();
  for (const item of items) {
    const key = item.eventDate ? item.eventDate.slice(0, 10) : `undated:${item.id}`;
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  return [...grouped.entries()].map(([key, rows]) => {
    const sorted = [...rows].sort((a, b) => compareEventBrackets(a, b));
    const first = sorted[0]!;
    const live = rows.some((row) => bucketFor(row, now) === 'live');
    const bucket = live ? 'live' : rows.some((row) => bucketFor(row, now) === 'upcoming') ? 'upcoming' : 'completed';
    return {
      key,
      slug: eventCanonicalSlug(rows, first.slug),
      title: eventNameOf(rows.map((row) => row.name)),
      eventDate: first.eventDate,
      items: sorted,
      bucket,
      live,
    };
  });
}
