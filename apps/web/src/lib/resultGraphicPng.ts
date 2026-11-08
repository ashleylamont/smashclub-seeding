import { characterName, isCharacterSlug } from '@smashclub/shared';
import { NEMESIS_MARK_PATHS } from './nemesisMark';
import { graphicMembers, type GraphicContext, type GraphicResult } from './resultGraphic';

const WIDTH = 960;
const PADDING = 36;
const GAP = 12;
const HEADER = 132;
const TILE = 114;
const OVERFLOW_COLUMNS = 4;
const MIN_FIELD_HEIGHT = 366;
const FOOTER = 42;
const MAX_CANVAS_EDGE = 4096;
const ink = '#181613';
const paper = '#f3ebda';
const orange = '#ff6543';
const muted = '#bdb2a3';
const mono = '"JetBrains Mono", monospace';
const headings = 'Oswald, sans-serif';
const reading = 'Inter, sans-serif';
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

type Rect = { x: number; y: number; width: number; height: number };
type Rows = readonly GraphicResult[];
type Tile = { bounds: Rect; row: GraphicResult; champion: boolean };

function layout(rows: Rows) {
  const champion = rows[0]?.place === 1 && rows[1]?.place !== 1 ? rows[0] : undefined;
  const rest = champion ? rows.slice(1) : rows;
  const besideChampion = champion ? rest.slice(0, 9) : rest;
  const overflow = champion ? rest.slice(besideChampion.length) : [];
  const heroWidth = !rest.length ? WIDTH - 2 * PADDING : rest.length <= 2 ? 360 : 270;
  const gridX = PADDING + (champion ? heroWidth + GAP : 0);
  const columns = Math.min(besideChampion.length, champion ? 3 : 4);
  const rowCount = columns ? Math.ceil(besideChampion.length / columns) : 0;
  const tileHeight = Math.max(TILE, Math.floor((MIN_FIELD_HEIGHT + GAP) / (rowCount || 1)) - GAP);
  const bodyHeight = rowCount ? rowCount * (tileHeight + GAP) - GAP : MIN_FIELD_HEIGHT;
  const tiles: Tile[] = [];
  if (champion) {
    tiles.push({
      bounds: { x: PADDING, y: HEADER, width: heroWidth, height: bodyHeight },
      row: champion,
      champion: true,
    });
  }
  if (columns) {
    const width = (WIDTH - PADDING - gridX - (columns - 1) * GAP) / columns;
    besideChampion.forEach((row, index) => {
      tiles.push({
        bounds: {
          x: gridX + (index % columns) * (width + GAP),
          y: HEADER + Math.floor(index / columns) * (tileHeight + GAP),
          width,
          height: tileHeight,
        },
        row,
        champion: false,
      });
    });
    const overflowX = (WIDTH - OVERFLOW_COLUMNS * width - (OVERFLOW_COLUMNS - 1) * GAP) / 2;
    overflow.forEach((row, index) => {
      tiles.push({
        bounds: {
          x: overflowX + (index % OVERFLOW_COLUMNS) * (width + GAP),
          y: HEADER + bodyHeight + GAP + Math.floor(index / OVERFLOW_COLUMNS) * (TILE + GAP),
          width,
          height: TILE,
        },
        row,
        champion: false,
      });
    });
  }
  return {
    tiles,
    height:
      HEADER + bodyHeight + Math.ceil(overflow.length / OVERFLOW_COLUMNS) * (TILE + GAP) + FOOTER,
  };
}

function label(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  width: number,
  font: string,
  fill: string,
) {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  ctx.font = font;
  ctx.fillStyle = fill;
  if (ctx.measureText(normalized).width <= width) {
    ctx.fillText(normalized, x, y);
    return;
  }
  let prefix = '';
  for (const { segment } of segmenter.segment(normalized)) {
    if (ctx.measureText(`${prefix}${segment}…`).width > width) break;
    prefix += segment;
  }
  ctx.fillText(`${prefix.trimEnd()}…`, x, y);
}

function streak(ctx: CanvasRenderingContext2D, width: number, height: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, height);
  ctx.lineTo(width * 0.58, 0);
  ctx.lineTo(width, 0);
  ctx.lineTo(width * 0.42, height);
  ctx.closePath();
  ctx.fill();
}

function mark(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(0.36, 0.36);
  ctx.fillStyle = orange;
  const fillPath = ctx.fill.bind(ctx);
  fillPath(new Path2D(NEMESIS_MARK_PATHS[0]));
  ctx.globalAlpha = 0.45;
  fillPath(new Path2D(NEMESIS_MARK_PATHS[1]));
  ctx.restore();
}

function displayDate(date: string | null) {
  if (!date || !Number.isFinite(Date.parse(date))) return 'Date unavailable';
  return new Intl.DateTimeFormat('en-AU', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'Australia/Sydney',
  }).format(new Date(date));
}

function artwork(
  ctx: CanvasRenderingContext2D,
  name: string,
  { x, y, width, height }: Rect,
  champion: boolean,
) {
  ctx.fillStyle = champion ? '#ddc8af' : '#514139';
  ctx.fillRect(x, y, width, height);
  const initials = Array.from(segmenter.segment(name.trim()), ({ segment }) => segment)
    .slice(0, 2)
    .join('');
  ctx.textAlign = 'center';
  label(
    ctx,
    initials.toLocaleUpperCase('en-AU'),
    x + width / 2,
    y + height * 0.69,
    width - 8,
    `700 ${Math.min(52, width / 2.35)}px ${headings}`,
    champion ? ink : paper,
  );
  ctx.textAlign = 'left';
}

function drawTile(ctx: CanvasRenderingContext2D, { bounds, row, champion }: Tile) {
  const { x, y, width, height } = bounds;
  const accent = champion ? ink : orange;
  const foreground = champion ? ink : paper;
  const secondary = champion ? '#584739' : muted;
  const members = graphicMembers(row);
  const teamName = row.graphic?.teamName;
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = champion ? paper : '#2a2520';
  ctx.fillRect(0, 0, width, height);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.clip();
  ctx.translate(champion ? width * 0.38 : width - 75, 0);
  streak(ctx, champion ? width : 108, height, champion ? '#e9dac4' : '#383027');
  ctx.restore();

  const ordinal = String(row.place).padStart(2, '0');
  label(
    ctx,
    ordinal,
    13,
    champion ? 98 : 36,
    width - 26,
    champion ? `700 104px ${headings}` : `700 33px ${headings}`,
    accent,
  );
  if (champion) {
    label(ctx, 'WINNER', 16, 122, width - 32, `700 12px ${mono}`, secondary);
  }
  const expanded = height > TILE;
  const cell = champion
    ? Math.min(94, (width - 48) / members.length)
    : expanded
      ? Math.min(94, Math.floor((height - TILE) * 0.7))
      : 30;
  const artworkY = champion ? 133 : expanded ? 16 : 7;
  const artworkX = champion ? 16 : width - 12 - members.length * (cell + 6) + 6;
  members.forEach(({ name }, index) =>
    artwork(
      ctx,
      name,
      { x: artworkX + index * (cell + 6), y: artworkY, width: cell, height: cell },
      champion,
    ),
  );

  const body = champion
    ? height - 110
    : expanded
      ? Math.max(56 + Math.round((height - TILE) * 0.58), artworkY + cell + 24)
      : 56;
  if (teamName) {
    label(
      ctx,
      teamName,
      14,
      body,
      width - 28,
      `700 ${champion ? 22 : 14}px ${reading}`,
      foreground,
    );
  }
  members.forEach(({ name, character }, index) => {
    const two = members.length > 1;
    const step = champion ? 38 : 23;
    const nameY = body + (teamName ? (champion ? 25 : 17) : 0) + index * step;
    const characterLabel = character && isCharacterSlug(character) ? characterName(character) : '';
    const size = champion ? (two ? 20 : 28) : two ? 13 : 19;
    const minSize = champion ? (two ? 15 : 20) : two ? 11 : 14;
    ctx.font = `700 ${size}px ${reading}`;
    const measured = ctx.measureText(name).width;
    const fitted = Math.max(minSize, Math.min(size, Math.floor((size * (width - 28)) / measured)));
    label(ctx, name, 14, nameY, width - 28, `700 ${fitted}px ${reading}`, foreground);
    if (characterLabel) {
      label(
        ctx,
        characterLabel,
        14,
        nameY + (champion ? 17 : 12),
        width - 28,
        `500 ${champion ? 13 : 10}px ${reading}`,
        secondary,
      );
    }
  });
  ctx.restore();
}

/** Draw the original Nemesis artwork and result facts into the export. */
export async function renderResultsPng(context: GraphicContext, rows: Rows): Promise<Blob | null> {
  const { tiles, height } = layout(rows);
  // Keep every recorded place even in unusually large pools or ties. Fit older
  // mobile canvas limits by scaling the whole graphic after it exceeds 4096px.
  const scale = Math.min(2, MAX_CANVAS_EDGE / height);
  const fonts = [
    `700 40px ${headings}`,
    `700 20px ${reading}`,
    `500 13px ${reading}`,
    `700 12px ${mono}`,
  ];
  const glyphs = `Nemesis ${context.eventName} ${context.scopeLabel} ${rows.map((row) => row.alias).join(' ')}`;
  await Promise.allSettled(fonts.map((font) => document.fonts.load(font, glyphs)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(WIDTH * scale);
  canvas.height = Math.min(MAX_CANVAS_EDGE, Math.ceil(height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(scale, scale);
  ctx.fillStyle = ink;
  ctx.fillRect(0, 0, WIDTH, height);
  ctx.fillStyle = orange;
  ctx.fillRect(0, 0, WIDTH, 6);
  mark(ctx, PADDING, 24);
  label(ctx, 'NEMESIS  /  SMASH CLUB', 84, 47, 550, `700 13px ${mono}`, orange);
  ctx.textAlign = 'right';
  label(
    ctx,
    displayDate(context.eventDate).toLocaleUpperCase('en-AU'),
    WIDTH - PADDING,
    47,
    232,
    `700 13px ${mono}`,
    muted,
  );
  ctx.textAlign = 'left';
  label(ctx, context.eventName, PADDING, 93, WIDTH - 2 * PADDING, `700 40px ${headings}`, paper);
  label(ctx, context.scopeLabel, PADDING, 117, WIDTH - 2 * PADDING, `700 16px ${reading}`, paper);

  for (const tile of tiles) drawTile(ctx, tile);

  const footer =
    context.kind === 'pool' ? 'CONFIRMED POOL PLACES' : 'CONFIRMED FINISHES THROUGH 8TH';
  const caption = `${footer}  /  ${context.format.toUpperCase()}`;
  label(ctx, caption, PADDING, height - 20, WIDTH - 2 * PADDING, `700 12px ${mono}`, muted);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}
