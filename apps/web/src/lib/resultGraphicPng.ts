import { characterName, isCharacterSlug } from '@smashclub/shared';
import { NEMESIS_MARK_PATHS } from './nemesisMark';
import {
  FIGHTER_ART_CREDIT,
  graphicMemberKey,
  graphicMembers,
  type GraphicContext,
  type GraphicResult,
} from './resultGraphic';

const WIDTH = 960;
const PADDING = 40;
const GAP = 12;
const HEADER = 108;
const FIELD_HEIGHT = 380;
const FOOTER = 52;
const OVERFLOW_HEIGHT = 114;
const OVERFLOW_COLUMNS = 4;
const MAX_CANVAS_EDGE = 4096;
const ink = '#171619';
const paper = '#fff4e5';
const orange = '#ff6847';
const muted = '#c7bdb1';
const mono = '"JetBrains Mono", monospace';
const headings = 'Oswald, sans-serif';
const reading = 'Inter, sans-serif';
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

type Rect = { x: number; y: number; width: number; height: number };
type Rows = readonly GraphicResult[];
type Tile = { bounds: Rect; row: GraphicResult; champion: boolean };
export type GraphicPortraits = Readonly<Record<string, HTMLCanvasElement | undefined>>;

function layout(rows: Rows) {
  const field = { x: PADDING, y: HEADER, width: WIDTH - 2 * PADDING, height: FIELD_HEIGHT };
  const champion = rows[0]?.place === 1 && rows[1]?.place !== 1 ? rows[0] : undefined;
  const tiles: Tile[] = [];
  const band = (entries: Rows, { x, y, width, height }: Rect) => {
    const tileWidth = (width - (entries.length - 1) * GAP) / entries.length;
    entries.forEach((row, index) => {
      tiles.push({
        bounds: { x: x + index * (tileWidth + GAP), y, width: tileWidth, height },
        row,
        champion: false,
      });
    });
  };

  let visible: number;
  if (champion) {
    const heroWidth = rows.length === 1 ? field.width : 272;
    tiles.push({ bounds: { ...field, width: heroWidth }, row: champion, champion: true });
    const upper = rows.slice(1, 4);
    const lower = rows.slice(4, 8);
    const support = {
      ...field,
      x: field.x + heroWidth + GAP,
      width: field.width - heroWidth - GAP,
    };
    const upperHeight = lower.length ? 212 : field.height;
    if (upper.length) band(upper, { ...support, height: upperHeight });
    if (lower.length)
      band(lower, {
        ...support,
        y: field.y + upperHeight + GAP,
        height: field.height - upperHeight - GAP,
      });
    visible = 1 + upper.length + lower.length;
  } else {
    const upper = rows.slice(0, OVERFLOW_COLUMNS);
    const lower = rows.slice(OVERFLOW_COLUMNS, 2 * OVERFLOW_COLUMNS);
    const upperHeight = lower.length ? (field.height - GAP) / 2 : field.height;
    if (upper.length) band(upper, { ...field, height: upperHeight });
    if (lower.length)
      band(lower, { ...field, y: field.y + upperHeight + GAP, height: upperHeight });
    visible = upper.length + lower.length;
  }

  let height = HEADER + FIELD_HEIGHT;
  for (let start = visible; start < rows.length; start += OVERFLOW_COLUMNS) {
    const entries = rows.slice(start, start + OVERFLOW_COLUMNS);
    const tileWidth = (field.width - (OVERFLOW_COLUMNS - 1) * GAP) / OVERFLOW_COLUMNS;
    band(entries, {
      ...field,
      y: height + GAP,
      height: OVERFLOW_HEIGHT,
      width: entries.length * tileWidth + (entries.length - 1) * GAP,
    });
    height += OVERFLOW_HEIGHT + GAP;
  }
  return { tiles, height: height + FOOTER };
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
  ctx.scale(0.25, 0.25);
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

const palettes = [
  ['#482b31', '#a95548', '#ff9877'],
  ['#263c49', '#486c79', '#a1d1ce'],
  ['#3e304b', '#765475', '#e6aecb'],
  ['#323b30', '#657a59', '#c5d7a0'],
] as const;

function artwork(
  ctx: CanvasRenderingContext2D,
  name: string,
  { x, y, width, height }: Rect,
  portrait: HTMLCanvasElement | undefined,
  bundled: boolean,
) {
  const seed = Array.from(name).reduce((sum, glyph) => sum + glyph.codePointAt(0)!, 0);
  const [dark, middle, light] = palettes[seed % palettes.length]!;
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.clip();
  const gradient = ctx.createLinearGradient(0, height, width, 0);
  gradient.addColorStop(0, dark);
  gradient.addColorStop(1, middle);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  ctx.save();
  ctx.translate(width * 0.26, 0);
  ctx.globalAlpha = 0.24;
  streak(ctx, width * 0.91, height, light);
  ctx.translate(width * 0.22, 0);
  streak(ctx, width * 0.36, height, dark);
  ctx.restore();

  ctx.strokeStyle = light;
  ctx.globalAlpha = 0.28;
  ctx.lineWidth = 1;
  for (const inset of [9, 15]) ctx.strokeRect(inset, inset, width - 2 * inset, height - 2 * inset);
  if (portrait) {
    const fit = bundled ? Math.min : Math.max;
    const scale = fit(width / portrait.width, height / portrait.height);
    const drawnWidth = portrait.width * scale;
    const drawnHeight = portrait.height * scale;
    ctx.globalAlpha = 1;
    ctx.drawImage(
      portrait,
      (width - drawnWidth) / 2,
      bundled ? height - drawnHeight : (height - drawnHeight) / 2,
      drawnWidth,
      drawnHeight,
    );
  } else {
    const initials = Array.from(segmenter.segment(name.trim()), ({ segment }) => segment)
      .slice(0, 2)
      .join('')
      .toLocaleUpperCase('en-AU');
    ctx.globalAlpha = 0.82;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    label(
      ctx,
      initials,
      width / 2,
      height * 0.59,
      width - 22,
      `700 ${Math.min(width * 0.37, height * 0.63)}px ${headings}`,
      light,
    );
  }
  ctx.restore();
}

function nameSize(
  ctx: CanvasRenderingContext2D,
  name: string,
  preferred: number,
  minimum: number,
  width: number,
) {
  ctx.font = `700 ${preferred}px ${reading}`;
  const measured = ctx.measureText(name).width;
  return Math.max(minimum, Math.min(preferred, Math.floor((preferred * width) / measured)));
}

function drawTile(
  ctx: CanvasRenderingContext2D,
  { bounds, row, champion }: Tile,
  rowIndex: number,
  portraits: GraphicPortraits,
  bundled: ReadonlySet<string>,
) {
  const { x, y, width, height } = bounds;
  const members = graphicMembers(row);
  const teamName = row.graphic?.teamName;
  const paired = members.length > 1;
  const captionHeight = champion ? (paired ? 88 : 75) : paired ? 63 : 47;
  const portraitHeight = height - captionHeight;
  const portraitWidth = width / members.length;
  ctx.save();
  ctx.translate(x, y);
  members.forEach(({ name }, index) => {
    const key = graphicMemberKey(row, rowIndex, index);
    artwork(
      ctx,
      name,
      {
        x: index * portraitWidth,
        y: 0,
        width: portraitWidth,
        height: portraitHeight,
      },
      portraits[key],
      bundled.has(key),
    );
  });
  if (paired) {
    ctx.fillStyle = ink;
    ctx.fillRect(portraitWidth - 1, 0, 2, portraitHeight);
  }

  const place = String(row.place);
  const rankSize = champion ? 88 : height > 180 ? 54 : 41;
  ctx.fillStyle = ink;
  ctx.globalAlpha = 0.89;
  const rankWidth = Math.max(champion ? 68 : 43, place.length * rankSize * 0.59 + 16);
  ctx.fillRect(0, 0, rankWidth, rankSize + (champion ? 14 : 8));
  ctx.globalAlpha = 1;
  label(
    ctx,
    place,
    champion ? 11 : 7,
    rankSize,
    rankWidth - 8,
    `700 ${rankSize}px ${headings}`,
    paper,
  );
  if (champion) {
    ctx.textAlign = 'right';
    ctx.fillStyle = ink;
    ctx.fillRect(width - 116, 0, 116, 27);
    label(ctx, 'WINNER', width - 12, 18, 92, `700 12px ${mono}`, paper);
  }
  ctx.textAlign = 'left';
  ctx.fillStyle = champion ? paper : '#242024';
  ctx.fillRect(0, portraitHeight, width, captionHeight);
  ctx.fillStyle = orange;
  ctx.fillRect(0, portraitHeight, width, champion ? 5 : 3);
  const foreground = champion ? ink : paper;
  const secondary = champion ? '#624944' : muted;
  ctx.textAlign = 'center';
  if (teamName) {
    label(
      ctx,
      teamName,
      width / 2,
      portraitHeight + (champion ? 26 : 16),
      width - 18,
      `700 ${champion ? 18 : 11}px ${mono}`,
      secondary,
    );
  }
  members.forEach(({ name, character }, index) => {
    const characterLabel = character && isCharacterSlug(character) ? characterName(character) : '';
    if (paired) {
      const inset = champion ? 14 : 8;
      const baseY = portraitHeight + (champion ? (teamName ? 52 : 34) : teamName ? 35 : 25);
      const y = baseY + index * (champion ? 24 : 18);
      const characterFont = `500 ${champion ? 12 : 9}px ${reading}`;
      ctx.font = characterFont;
      const characterWidth = Math.min(width * 0.34, ctx.measureText(characterLabel).width);
      const nameWidth = width - inset * 2 - (characterWidth ? characterWidth + 8 : 0);
      const size = nameSize(ctx, name, champion ? 22 : 15, champion ? 15 : 11, nameWidth);
      ctx.textAlign = 'left';
      label(ctx, name, inset, y, nameWidth, `700 ${size}px ${reading}`, foreground);
      ctx.textAlign = 'right';
      if (characterLabel)
        label(ctx, characterLabel, width - inset, y, characterWidth, characterFont, secondary);
      return;
    }

    const labelWidth = width - 22;
    const nameY = portraitHeight + (champion ? 47 : 29);
    const size = nameSize(ctx, name, champion ? 39 : 25, champion ? 24 : 15, labelWidth);
    label(ctx, name, width / 2, nameY, labelWidth, `700 ${size}px ${reading}`, foreground);
    if (characterLabel)
      label(
        ctx,
        characterLabel,
        width / 2,
        nameY + (champion ? 17 : 12),
        labelWidth,
        `500 ${champion ? 13 : 10}px ${reading}`,
        secondary,
      );
  });
  ctx.restore();
}

/** Draw the original Nemesis artwork and result facts into the export. */
export async function renderResultsPng(
  context: GraphicContext,
  rows: Rows,
  portraits: GraphicPortraits,
  bundled: ReadonlySet<string>,
): Promise<Blob | null> {
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
  mark(ctx, PADDING, 18);
  label(ctx, 'NEMESIS  /  SMASH CLUB', 72, 38, 550, `700 12px ${mono}`, orange);
  ctx.textAlign = 'right';
  label(
    ctx,
    displayDate(context.eventDate).toLocaleUpperCase('en-AU'),
    WIDTH - PADDING,
    40,
    232,
    `700 13px ${mono}`,
    muted,
  );
  ctx.textAlign = 'left';
  label(ctx, context.eventName, PADDING, 76, WIDTH - 2 * PADDING, `700 37px ${headings}`, paper);
  label(ctx, context.scopeLabel, PADDING, 96, WIDTH - 2 * PADDING, `700 16px ${reading}`, paper);

  tiles.forEach((tile, index) => drawTile(ctx, tile, index, portraits, bundled));

  const footer = context.kind === 'pool' ? 'POOLS' : 'TOP 8';
  const caption = `${footer}  /  ${context.format.toUpperCase()}`;
  label(ctx, caption, PADDING, height - 20, WIDTH - 2 * PADDING, `700 12px ${mono}`, muted);
  if (bundled.size) {
    ctx.textAlign = 'right';
    label(ctx, FIGHTER_ART_CREDIT, WIDTH - PADDING, height - 20, 440, `500 11px ${reading}`, muted);
  }
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}
