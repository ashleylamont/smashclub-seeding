import {
  liveBracketFeeds,
  liveBracketLanes,
  liveBracketRound,
  liveBracketSide,
} from './eventBracket';
import { poolStandings } from './eventQueue';
import type { LiveMatch } from './eventDisplay';
import type { NativeBracketView } from '../components/EventNightBoard';

export type BroadcastPresentation = 'gameplay' | 'auto' | 'progress';
export function broadcastPresentation(search: string): BroadcastPresentation {
  const mode = new URLSearchParams(search).get('presentation');
  return mode === 'auto' || mode === 'progress' ? mode : 'gameplay';
}
export function progressInterval(search: string) {
  const seconds = Number(new URLSearchParams(search).get('cycleSeconds'));
  return seconds === 15 || seconds === 60 ? seconds : 30;
}
export type ProgressData = {
  plan: { id: string; name: string; status: string };
  matches: LiveMatch[];
  nativeBrackets: NativeBracketView[];
  entrants: { id: string; name: string }[];
};
type Pool = ReturnType<typeof poolStandings>[number];
type Bracket = ProgressData['nativeBrackets'][number];
export type ProgressPage =
  | { kind: 'pool'; key: string; pool: Pool; players: Pool['players']; part: number; parts: number }
  | {
      kind: 'bracket';
      key: string;
      bracket: Bracket;
      lane: ReturnType<typeof liveBracketLanes>[number];
      matches: LiveMatch[];
      roundTitles: string[];
      part: number;
      parts: number;
    }
  | { kind: 'summary'; key: 'summary' };

const chunks = <T>(items: T[], count: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / count) }, (_, i) =>
    items.slice(i * count, (i + 1) * count),
  );

/** Two adjacent rounds, at most two cards per column. Every actual match is covered. */
function laneWindows(lane: ReturnType<typeof liveBracketLanes>[number]) {
  const ordered = [...lane.matches].sort(
    (a, b) =>
      liveBracketRound(a) - liveBracketRound(b) ||
      (a.nativeSlot ?? 0) - (b.nativeSlot ?? 0) ||
      a.id.localeCompare(b.id),
  );
  const labels = new Map(ordered.map((match) => [match.id, match.label]));
  const perColumn = ordered.some(
    (match) =>
      liveBracketSide(match, 0, labels).length + liveBracketSide(match, 1, labels).length > 140,
  )
    ? 1
    : 2;
  return chunks(
    [...new Set(ordered.map(liveBracketRound))].sort((a, b) => a - b),
    2,
  ).flatMap((rounds) => {
    const first = ordered.filter((m) => liveBracketRound(m) === rounds[0]);
    const later = ordered.filter((m) => liveBracketRound(m) === rounds[1]);
    const covered = new Set<string>();
    const windows = chunks(first, perColumn).flatMap((leading) => {
      const ids = new Set(leading.map((m) => m.id));
      const following = later.filter((m) =>
        liveBracketFeeds(m).some((feed) => ids.has(feed.matchId)),
      );
      following.forEach((m) => covered.add(m.id));
      const groups = chunks(following, perColumn);
      return groups.length ? groups.map((group) => [...leading, ...group]) : [leading];
    });
    return [
      ...windows,
      ...chunks(
        later.filter((m) => !covered.has(m.id)),
        perColumn,
      ),
    ];
  });
}

export function broadcastProgressPages(data: ProgressData): ProgressPage[] {
  const pages: ProgressPage[] = [];
  for (const pool of poolStandings(data.matches).sort(
    (a, b) => a.division.localeCompare(b.division) || a.poolIndex - b.poolIndex,
  )) {
    const parts = chunks(pool.players, 6);
    parts.forEach((players, index) =>
      pages.push({
        kind: 'pool',
        key: `pool:${pool.division}:${pool.poolIndex}:${index}`,
        pool,
        players,
        part: index + 1,
        parts: parts.length,
      }),
    );
  }
  for (const bracket of data.nativeBrackets) {
    const lanes = liveBracketLanes(data.matches.filter((m) => m.nativeBracketId === bracket.id));
    if (!lanes.length) lanes.push({ key: 'winners', title: '', matches: [] });
    for (const lane of lanes) {
      const windows = laneWindows(lane);
      if (!windows.length) windows.push([]);
      windows.forEach((matches, index) => {
        const rounds = [...new Set(matches.map(liveBracketRound))].sort((a, b) => a - b);
        pages.push({
          kind: 'bracket',
          key: `draw:${bracket.id}:${lane.key}:${index}`,
          bracket,
          lane,
          matches,
          roundTitles: rounds.map((round) =>
            lane.key === 'finals'
              ? round === 1
                ? 'Grand final'
                : 'Reset · if needed'
              : `${lane.title || 'Bracket'} · Round ${round}`,
          ),
          part: index + 1,
          parts: windows.length,
        });
      });
    }
  }
  if (!pages.length || ['complete', 'cancelled'].includes(data.plan.status))
    pages.push({ kind: 'summary', key: 'summary' });
  return pages;
}
