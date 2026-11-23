import type { TournamentStructure } from '@smashclub/shared';
import { poolLabel } from '@smashclub/tournament-formats';
import { escapeSvg, stripInvalidXmlCharacters } from './svgText';

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

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const resultFont = 'Arial, sans-serif';
const rowTextX = 158;
const rowTextWidth = 994;
// The standalone SVG may be opened with a different fallback font.
const teamTextWidth = rowTextWidth - 16;

type MeasureText = (value: string, size: number, bold: boolean) => number;

function resultTextMeasure(): MeasureText {
  const ctx =
    typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  return (value, size, bold) => {
    if (!ctx) return Array.from(value).length * size;
    ctx.font = `${bold ? 'bold ' : ''}${size}px ${resultFont}`;
    const { width, actualBoundingBoxRight } = ctx.measureText(value);
    return Math.max(width, actualBoundingBoxRight);
  };
}

function fittedFontSize(
  text: string,
  size: number,
  width: number,
  bold: boolean,
  measure: MeasureText,
) {
  const scaled = Math.min(size, (size * width) / Math.max(1, measure(text, size, bold)));
  // Leave a small allowance for differences in browser SVG and canvas text rounding.
  const maxGlyphWidth = width - 2;
  const fits = (hundredths: number) => measure(text, hundredths / 100, bold) <= maxGlyphWidth;
  const preferred = Math.round(scaled * 100);
  if (fits(preferred)) return (preferred / 100).toFixed(2);

  // Bitmap and fallback glyph widths can jump between sizes. Measure each candidate
  // at the size the SVG will render and retain only sizes that fit.
  let fitting = 0;
  let overflowing = preferred;
  while (overflowing - fitting > 1) {
    const candidate = Math.floor((fitting + overflowing) / 2);
    if (fits(candidate)) fitting = candidate;
    else overflowing = candidate;
  }
  return (fitting / 100).toFixed(2);
}

function singleLine(
  value: string,
  limit: number,
  style: { x: number; y: number; width: number; size: number; fill: string; bold?: boolean },
  measure: MeasureText,
) {
  const { x, y, width, size, fill, bold = false } = style;
  let text = '';
  for (const { index, segment } of graphemes.segment(stripInvalidXmlCharacters(value))) {
    if (index >= limit) break;
    text += segment;
  }
  // Keep the existing scale for short labels and reserve room for wide fallback glyphs.
  const preferred = Math.min(size, width / Math.max(1, Array.from(text).length));
  return `<text x="${x}" y="${y}" fill="${fill}"${bold ? ' font-weight="bold"' : ''} font-size="${fittedFontSize(text, preferred, width, bold, measure)}">${escapeSvg(text)}</text>`;
}

function wrapLabel(value: string, fits: (line: string) => boolean) {
  const lines: string[] = [];
  let line = '';
  let lastSpace = 0;
  for (const { segment } of graphemes.segment(value)) {
    if (line && !fits(line + segment)) {
      // Prefer a nearby word break while keeping long, unbroken aliases intact.
      const tailFits = fits(line.slice(lastSpace) + segment);
      const split = tailFits && lastSpace >= line.length / 2 ? lastSpace : line.length;
      lines.push(line.slice(0, split));
      line = line.slice(split);
      lastSpace = 0;
    }
    line += segment;
    if (/^\s+$/u.test(segment)) lastSpace = line.length;
  }
  if (line) lines.push(line);
  return lines;
}

function teamLabels(
  graphic: GraphicIdentity,
  detail: string | undefined,
  top: number,
  textColor: string,
  secondaryColor: string,
  measure: MeasureText,
) {
  const labels = [
    ...(graphic.teamName
      ? [{ value: graphic.teamName, size: 29, color: textColor, bold: true }]
      : []),
    ...graphic.members.map(({ name }) => ({
      value: name,
      size: 22,
      color: secondaryColor,
      bold: false,
    })),
    ...(detail ? [{ value: detail, size: 18, color: secondaryColor, bold: false }] : []),
  ];
  let baseline = top + 8;
  const markup = labels
    .map(({ value, size, color, bold }, index) => {
      if (index > 0) baseline += 6;
      const lines = wrapLabel(
        stripInvalidXmlCharacters(value),
        (line) => measure(line, size, bold) <= teamTextWidth,
      );
      const label = lines.map((line) => {
        baseline += size + 8;
        return `<tspan x="${rowTextX}" y="${baseline}" font-size="${fittedFontSize(line, size, teamTextWidth, bold, measure)}">${escapeSvg(line)}</tspan>`;
      });
      return `<text fill="${color}" font-size="${size}"${bold ? ' font-weight="bold"' : ''}>${label.join('')}</text>`;
    })
    .join('');
  return { markup, height: Math.max(86, baseline - top + 17) };
}

export function resultsSvg(
  title: string,
  results: readonly GraphicResult[],
  kind: GraphicContext['kind'] = 'bracket',
): string {
  const measure = resultTextMeasure();
  let top = 166;
  const rows = rankedGraphicResults(results, kind)
    .map((row, index) => {
      const fill = index === 0 ? '#eee9dc' : '#24231e';
      const text = index === 0 ? '#141411' : '#eee9dc';
      const { graphic } = row;
      const labels =
        graphic?.members.length && (graphic.teamName || graphic.members.length > 1)
          ? teamLabels(graphic, row.detail, top, text, index === 0 ? '#514b41' : '#bcb3a4', measure)
          : {
              height: 86,
              markup:
                singleLine(
                  row.alias,
                  48,
                  {
                    x: rowTextX,
                    y: top + 45,
                    width: rowTextWidth,
                    size: 29,
                    fill: text,
                    bold: true,
                  },
                  measure,
                ) +
                singleLine(
                  row.detail ?? '',
                  82,
                  { x: rowTextX, y: top + 72, width: rowTextWidth, size: 18, fill: '#9c9588' },
                  measure,
                ),
            };
      const markup = `<rect x="48" y="${top}" width="1104" height="${labels.height}" fill="${fill}"/><text x="76" y="${top + 54}" fill="#f34b2c" font-size="32">${row.place}</text>${labels.markup}`;
      top += labels.height + 12;
      return markup;
    })
    .join('');
  const height = top + 64;
  const heading = singleLine(
    title,
    52,
    { x: 64, y: 126, width: 1088, size: 38, fill: 'white', bold: true },
    measure,
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${height}" viewBox="0 0 1200 ${height}"><rect width="1200" height="${height}" fill="#141411"/><rect width="14" height="${height}" fill="#f34b2c"/><g font-family="${resultFont}"><text x="64" y="64" fill="#f34b2c" font-size="22" letter-spacing="5">SMASH CLUB · RESULTS</text>${heading}${rows}</g></svg>`;
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
