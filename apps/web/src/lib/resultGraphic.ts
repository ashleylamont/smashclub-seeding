import type { TournamentStructure } from '@smashclub/shared';
import { poolLabel } from '@smashclub/tournament-formats';

export const FIGHTER_ART_CREDIT = 'Fighter artwork © Nintendo and respective rights holders';

export interface GraphicMember {
  name: string;
  character: string | null;
}

export interface GraphicIdentity {
  teamName: string | null;
  members: readonly GraphicMember[];
}

export interface GraphicContext {
  eventName: string;
  eventDate: string | null;
  scopeLabel: string;
  kind: 'division' | 'bracket' | 'pool';
  format: 'singles' | 'doubles';
  source: { planId: string } | { tournamentIds: string[] };
}

/** Public aliases only: callers must use the public event snapshot. */
export interface GraphicResult {
  place: number;
  alias: string;
  entryKey?: string;
  graphic?: GraphicIdentity;
  detail?: string;
}
export function escapeSvg(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!,
  );
}
/** Bound even wide glyphs to the available canvas; truncation alone is insufficient. */
function fittedFontSize(text: string, preferred: number, width: number) {
  return Math.min(preferred, width / Math.max(1, Array.from(text).length)).toFixed(2);
}
export function resultsSvg(
  title: string,
  results: readonly GraphicResult[],
  kind: GraphicContext['kind'] = 'bracket',
): string {
  const rows = rankedGraphicResults(results, kind);
  const height = 230 + rows.length * 98;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${height}" viewBox="0 0 1200 ${height}"><rect width="1200" height="${height}" fill="#141411"/><rect width="14" height="${height}" fill="#f34b2c"/><g font-family="Arial, sans-serif"><text x="64" y="64" fill="#f34b2c" font-size="22" letter-spacing="5">SMASH CLUB · RESULTS</text><text x="64" y="126" fill="white" font-weight="bold" font-size="${fittedFontSize(title.slice(0, 52), 38, 1088)}">${escapeSvg(title.slice(0, 52))}</text>${rows.map((row, index) => `<rect x="48" y="${166 + index * 98}" width="1104" height="86" fill="${index === 0 ? '#eee9dc' : '#24231e'}"/><text x="76" y="${220 + index * 98}" fill="#f34b2c" font-size="32">${row.place}</text><text x="158" y="${211 + index * 98}" fill="${index === 0 ? '#141411' : '#eee9dc'}" font-weight="bold" font-size="${fittedFontSize(row.alias.slice(0, 48), 29, 994)}">${escapeSvg(row.alias.slice(0, 48))}</text><text x="158" y="${238 + index * 98}" fill="#9c9588" font-size="${fittedFontSize((row.detail ?? '').slice(0, 82), 18, 994)}">${escapeSvg((row.detail ?? '').slice(0, 82))}</text>`).join('')}</g></svg>`;
}

/** A tie at the cutoff shares its actual place and stays together. */
export function rankedGraphicResults(
  results: readonly GraphicResult[],
  kind: GraphicContext['kind'],
): GraphicResult[] {
  return results
    .filter(({ place }) => Number.isInteger(place) && place >= 1 && (kind === 'pool' || place <= 8))
    .sort((a, b) => a.place - b.place);
}

export function graphicMemberKey(row: GraphicResult, rowIndex: number, memberIndex: number) {
  return `${row.entryKey ?? rowIndex}:${memberIndex}`;
}

export function graphicMembers(result: GraphicResult): readonly GraphicMember[] {
  return result.graphic?.members.length
    ? result.graphic.members
    : [{ name: result.alias, character: null }];
}

/** Pool placements are never presented as overall event places. */
export function confirmedPoolGraphics(
  placements: readonly { division: string; poolIndex: number; playerId: string; place: number }[],
  entrants: readonly { id: string; name: string; graphic?: GraphicIdentity }[],
  structure?: TournamentStructure,
): { title: string; results: GraphicResult[] }[] {
  const byId = new Map(entrants.map((entrant) => [entrant.id, entrant]));
  const pools = new Map<string, { title: string; results: GraphicResult[] }>();
  const open = structure && structure !== 'dual_division';
  for (const placement of placements) {
    const entrant = byId.get(placement.playerId);
    if (!entrant?.name || !Number.isInteger(placement.place) || placement.place < 1) continue;
    const { division, poolIndex } = placement;
    const key = `${division}:${poolIndex}`;
    const divisionLabel = open ? 'Open' : division === 'upper' ? 'Upper' : 'Lower';
    const title =
      structure === 'round_robin'
        ? 'Open round robin'
        : `${divisionLabel} · Pool ${poolLabel(poolIndex)}`;
    const pool = pools.get(key) ?? { title, results: [] };
    pool.results.push({
      entryKey: entrant.id,
      place: placement.place,
      alias: entrant.name,
      detail: 'Confirmed pool placement',
      graphic: entrant.graphic,
    });
    pools.set(key, pool);
  }
  return [...pools.values()]
    .sort((a, b) => a.title.localeCompare(b.title))
    .map(({ title, results }) => ({ title, results: results.sort((a, b) => a.place - b.place) }));
}
