import {
  isNativeRoundRobin,
  liveBracketFeeds,
  liveBracketLanes,
  liveBracketRound,
  liveBracketSide,
} from './eventBracket';
import { poolStandings } from './eventQueue';
import { intermissionRecentResults } from './broadcastResults';
import type { LiveMatch, PoolQualifierSlot } from './eventDisplay';
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
  poolScope?: string;
  entrants: { id: string; name: string }[];
};
type Pool = ReturnType<typeof poolStandings>[number];
type QualificationSlot = Omit<PoolQualifierSlot, 'eligibleEntrantIds' | 'candidateEntrantIds'>;
type PoolQualification = QualificationSlot & { stage: PublicFinalsField['stage'] };
export type PoolPanel = {
  key: string;
  pool: Pool;
  players: Pool['players'];
  qualifications: PoolQualification[];
};
type Bracket = ProgressData['nativeBrackets'][number];
type LinkedBracket = {
  division: 'upper' | 'lower';
  stage: 'main' | 'consolation';
  slug: string | null;
};
export type ProgressPage =
  | { kind: 'pool'; key: string; panels: PoolPanel[] }
  | {
      kind: 'round-robin-results';
      key: string;
      standings: Bracket['standings'];
      records: ReadonlyMap<string, Pool['players'][number]>;
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
  | { kind: 'recent-results'; key: 'recent-results'; matches: LiveMatch[] }
  | { kind: 'summary'; key: 'summary' };

const chunks = <T>(items: T[], count: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / count) }, (_, i) =>
    items.slice(i * count, (i + 1) * count),
  );

export function broadcastPageDensity(width: number) {
  return {
    poolsPerPage: width < 1000 ? 1 : 2,
    bracketColumns: width < 650 ? 1 : width < 1100 ? 2 : 3,
  };
}

/** Fill adjacent columns, keeping a match beside a visible feeder where space permits. */
function laneWindows(lane: ReturnType<typeof liveBracketLanes>[number], columns: number) {
  const ordered = lane.matches.toSorted(
    (a, b) =>
      liveBracketRound(a) - liveBracketRound(b) ||
      (a.nativeSlot ?? 0) - (b.nativeSlot ?? 0) ||
      a.id.localeCompare(b.id),
  );
  const rounds = [...new Set(ordered.map(liveBracketRound))];
  const labels = new Map(ordered.map(({ id, label }) => [id, label]));
  const cardsPerColumn = ordered.some(
    (match) =>
      liveBracketSide(match, 0, labels).length + liveBracketSide(match, 1, labels).length > 140,
  )
    ? 2
    : 3;
  // Group from the last round so the final rounds share a page.
  return chunks(rounds.reverse(), columns)
    .reverse()
    .flatMap((group) => {
      const windows: LiveMatch[][] = [];
      for (const round of group.reverse()) {
        const counts = windows.map(() => 0);
        for (const match of ordered.filter((item) => liveBracketRound(item) === round)) {
          const feeds = liveBracketFeeds(match);
          let index = windows.findIndex(
            (window, i) =>
              counts[i]! < cardsPerColumn &&
              feeds.some(({ matchId }) => window.some((item) => item.id === matchId)),
          );
          if (index === -1) index = counts.findIndex((count) => count < cardsPerColumn);
          if (index === -1) {
            index = windows.length;
            windows.push([]);
            counts.push(0);
          }
          windows[index]!.push(match);
          counts[index]!++;
        }
      }
      return windows;
    });
}

function poolPanels(data: ProgressData) {
  const keyFor = ({ division, poolIndex }: { division: string; poolIndex: number }) =>
    `${division}:${poolIndex}`;
  const pools = new Map(poolStandings(data.matches).map((pool) => [keyFor(pool), pool]));
  const qualifications = new Map<string, PoolQualification[]>();
  for (const { stage, slots } of [
    ...(data.pendingFinals ?? []),
    ...data.nativeBrackets.flatMap<{
      stage: PublicFinalsField['stage'];
      slots: QualificationSlot[];
    }>((bracket) =>
      (bracket.stage === 'main' || bracket.stage === 'consolation') && bracket.qualifierSlots
        ? [{ stage: bracket.stage, slots: bracket.qualifierSlots }]
        : [],
    ),
  ]) {
    for (const slot of slots) {
      const key = keyFor(slot);
      if (data.poolScope && data.poolScope !== key) continue;
      const existing = qualifications.get(key) ?? [];
      const { poolId, poolIndex, division, status, entrantId, place } = slot;
      existing.push({ poolId, poolIndex, division, status, entrantId, place, stage });
      qualifications.set(key, existing);
      if (!pools.has(key))
        pools.set(key, {
          division: slot.division,
          poolIndex: slot.poolIndex,
          complete: 0,
          total: 0,
          players: [],
        });
    }
  }
  return [...pools.entries()]
    .sort(([, a], [, b]) => a.division.localeCompare(b.division) || a.poolIndex - b.poolIndex)
    .flatMap(([key, pool]): PoolPanel[] => {
      const slots = qualifications.get(key) ?? [];
      const playerIds = new Set(pool.players.map(({ id }) => id));
      const groups = pool.players.length ? chunks(pool.players, 6) : [[]];
      return groups.map((players, index) => ({
        key: `${key}:${index}`,
        pool,
        players,
        qualifications: slots.filter(({ status, entrantId }) =>
          status === 'resolved' && entrantId && playerIds.has(entrantId)
            ? players.some(({ id }) => id === entrantId)
            : index === 0,
        ),
      }));
    });
}

export function broadcastProgressPages(
  data: ProgressData,
  preferRecent = false,
  { poolsPerPage, bracketColumns } = broadcastPageDensity(1280),
): ProgressPage[] {
  const pages: ProgressPage[] = [];
  const roundRobin = isNativeRoundRobin(data.plan);
  const roundRobinResult =
    roundRobin && !data.poolScope
      ? data.nativeBrackets.find(
          (bracket) => bracket.division === 'upper' && bracket.stage === 'main' && bracket.complete,
        )
      : undefined;
  if (roundRobinResult) {
    const records = new Map(
      poolStandings(data.matches).flatMap(({ players }) =>
        players.map((player) => [player.id, player] as const),
      ),
    );
    chunks(roundRobinResult.standings, 6).forEach((standings, index) => {
      pages.push({
        kind: 'round-robin-results',
        key: `round-robin-results:${roundRobinResult.id}:${index}`,
        standings,
        winnerId: roundRobinResult.winnerId,
        records,
      });
    });
  } else {
    for (const panels of chunks(poolPanels(data), poolsPerPage)) {
      pages.push({ kind: 'pool', key: `pool:${panels[0]!.key}`, panels });
    }
  }
  for (const bracket of roundRobin || data.poolScope ? [] : data.nativeBrackets) {
    const lanes = liveBracketLanes(data.matches.filter((m) => m.nativeBracketId === bracket.id));
    for (const lane of lanes) {
      const windows = laneWindows(lane, bracketColumns);
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
  for (const bracket of data.poolScope ? [] : (data.linkedBrackets ?? [])) {
    if (!bracket.slug) continue;
    const matches = data.matches.filter(
      (match) =>
        match.sourceSetId &&
        !match.nativeBracketId &&
        match.division === bracket.division &&
        match.stage === bracket.stage,
    );
    chunks(matches, 5).forEach((matches, index) =>
      pages.push({
        kind: 'linked',
        key: `linked:${bracket.division}:${bracket.stage}:${index}`,
        bracket,
        matches,
      }),
    );
  }
  const closed = ['complete', 'cancelled'].includes(data.plan.status);
  const recent = intermissionRecentResults(data.matches);
  if (recent.length) {
    const page = { kind: 'recent-results', key: 'recent-results', matches: recent } as const;
    if (
      preferRecent &&
      !closed &&
      pages[0]?.kind !== 'round-robin-results' &&
      recent.some((match) => match.outcome !== 'bye')
    )
      pages.unshift(page);
    else pages.push(page);
  }
  if (!pages.length || closed) pages.push({ kind: 'summary', key: 'summary' });
  return pages;
}
