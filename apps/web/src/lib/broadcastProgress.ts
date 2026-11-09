import {
  isNativeRoundRobin,
  liveBracketFeeds,
  liveBracketLanes,
  liveBracketRound,
  liveBracketSide,
} from './eventBracket';
import { poolStandings } from './eventQueue';
import type { LiveMatch } from './eventDisplay';
import type { PublicFinalsField } from './qualification';
import type { NativeBracketView } from '../components/EventNightBoard';

export type BroadcastPresentation = 'gameplay' | 'auto' | 'progress';
export const DEFAULT_PROGRESS_SECONDS = 10;
export const progressIntervals = [DEFAULT_PROGRESS_SECONDS, 15, 30, 60] as const;

export function broadcastPresentation(search: string): BroadcastPresentation {
  const mode = new URLSearchParams(search).get('presentation');
  return mode === 'gameplay' || mode === 'progress' ? mode : 'auto';
}
export function progressInterval(search: string): number {
  const seconds = Number(new URLSearchParams(search).get('cycleSeconds'));
  return progressIntervals.find((option) => option === seconds) ?? DEFAULT_PROGRESS_SECONDS;
}
export type ProgressData = {
  publicCode?: number;
  plan: { id: string; name: string; status: string; bracketMode?: string; structure?: string };
  matches: LiveMatch[];
  nativeBrackets: NativeBracketView[];
  linkedBrackets?: LinkedBracket[];
  pendingFinals?: PublicFinalsField[];
  entrants: { id: string; name: string }[];
};
type Pool = ReturnType<typeof poolStandings>[number];
type Bracket = ProgressData['nativeBrackets'][number];
type LinkedBracket = {
  division: 'upper' | 'lower';
  stage: 'main' | 'consolation';
  slug: string | null;
};
export type ProgressPage =
  | { kind: 'pool'; key: string; pool: Pool; players: Pool['players'] }
  | {
      kind: 'round-robin-results';
      key: string;
      standings: Bracket['standings'];
      winnerId: Bracket['winnerId'];
    }
  | {
      kind: 'bracket';
      key: string;
      bracket: Bracket;
      lane: ReturnType<typeof liveBracketLanes>[number];
      matches: LiveMatch[];
      roundTitles: string[];
    }
  | {
      kind: 'linked';
      key: string;
      bracket: LinkedBracket;
      matches: LiveMatch[];
    }
  | (PublicFinalsField & { kind: 'qualification'; key: string })
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
  const roundRobin = isNativeRoundRobin(data.plan);
  if (roundRobin) {
    const result = data.nativeBrackets.find(
      (bracket) => bracket.division === 'upper' && bracket.stage === 'main' && bracket.complete,
    );
    if (result) {
      chunks(result.standings, 6).forEach((standings, index) => {
        pages.push({
          kind: 'round-robin-results',
          key: `round-robin-results:${result.id}:${index}`,
          standings,
          winnerId: result.winnerId,
        });
      });
    }
  }
  for (const pool of poolStandings(data.matches).sort(
    (a, b) => a.division.localeCompare(b.division) || a.poolIndex - b.poolIndex,
  )) {
    chunks(pool.players, 6).forEach((players, index) =>
      pages.push({
        kind: 'pool',
        key: `pool:${pool.division}:${pool.poolIndex}:${index}`,
        pool,
        players,
      }),
    );
  }
  for (const bracket of roundRobin ? [] : data.nativeBrackets) {
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
              : `Round ${round}`,
          ),
        });
      });
    }
  }
  for (const bracket of data.linkedBrackets ?? []) {
    if (!bracket.slug) continue;
    const matches = data.matches.filter(
      (match) =>
        match.sourceSetId &&
        !match.nativeBracketId &&
        match.division === bracket.division &&
        match.stage === bracket.stage,
    );
    chunks(matches, 3).forEach((matches, index) =>
      pages.push({
        kind: 'linked',
        key: `linked:${bracket.division}:${bracket.stage}:${index}`,
        bracket,
        matches,
      }),
    );
  }
  for (const { division, stage, slots } of data.pendingFinals ?? []) {
    chunks(slots, 4).forEach((slots, index) =>
      pages.push({
        kind: 'qualification',
        key: `qualification:${division}:${stage}:${index}`,
        division,
        stage,
        slots,
      }),
    );
  }
  if (!pages.length || ['complete', 'cancelled'].includes(data.plan.status))
    pages.push({ kind: 'summary', key: 'summary' });
  return pages;
}
