import { eliminationLaneLayout, eliminationLaneRow } from './eliminationLayout';
import {
  liveBracketFeeds,
  liveBracketLanes,
  liveBracketRound,
  liveBracketSide,
  liveBracketSourceSide,
  liveBracketStatus,
  liveBracketWinner,
} from './eventBracket';
import type { LiveMatch } from './eventDisplay';
import { isUntakenCall, matchPresentation } from './matchPresentation';
import { escapeSvg } from './resultGraphic';
import { NEMESIS_MARK_PATHS } from './nemesisMark';

export type BracketGraphicContext = {
  eventName: string;
  eventDate: string;
  scope: string;
  state: 'published' | 'paused' | 'closed';
  format: 'singles' | 'doubles';
};
type Measure = (value: string, size: number, bold: boolean) => number;
export type BracketGraphicImage = { svg: string; width: number; height: number };

const cardWidth = 364;
const lineHeight = 21;
const padding = 24;
const font = 'Arial, sans-serif';
const graphemes = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter() : undefined;
const laneOrder = { winners: 0, losers: 1, finals: 2 };
const colors = {
  background: '#141411',
  card: '#24231e',
  divider: '#514b41',
  text: '#eee9dc',
  muted: '#bcb3a4',
  red: '#ff684c',
  gold: '#f6a34a',
};

export function hasExportableBracket(matches: readonly LiveMatch[]) {
  if (!matches.length || matches.length > 1023) return false;
  const byId = new Map(matches.map((match) => [match.id, match]));
  const positions = new Set<string>();
  if (byId.size !== matches.length) return false;
  return matches.every((match) => {
    const lane = graphicLane(match.bracketLane);
    const round = liveBracketRound(match);
    const slot = match.nativeSlot;
    const position = `${lane}:${round}:${slot}`;
    if (
      !lane ||
      !match.nativeBracketId ||
      match.nativeBracketId !== matches[0]?.nativeBracketId ||
      match.stage === 'group' ||
      !Number.isInteger(match.bracketRound ?? match.nativeRound) ||
      round < 1 ||
      round > 18 ||
      typeof slot !== 'number' ||
      !Number.isInteger(slot) ||
      slot < 0 ||
      eliminationLaneRow(lane, round - 1, slot) > 511 ||
      positions.has(position)
    )
      return false;
    positions.add(position);
    return liveBracketFeeds(match).every(({ matchId }) => {
      const parent = byId.get(matchId);
      const sourceLane = parent && graphicLane(parent.bracketLane);
      return Boolean(
        parent &&
        sourceLane &&
        (sourceLane === lane
          ? liveBracketRound(parent) < round
          : laneOrder[sourceLane] < laneOrder[lane]),
      );
    });
  });
}

function graphicLane(lane?: string) {
  if (!lane || lane === 'winners') return 'winners';
  if (lane === 'losers') return 'losers';
  if (lane === 'final' || lane === 'reset') return 'finals';
}

function wrapText(value: string, width: number, size: number, bold: boolean, measure: Measure) {
  const lines: string[] = [];
  let line = '';
  for (const word of value.trim().split(/\s+/u)) {
    const next = line ? `${line} ${word}` : word;
    if (measure(next, size, bold) <= width) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    line = '';
    const letters = graphemes
      ? Array.from(graphemes.segment(word), ({ segment }) => segment)
      : Array.from(word);
    for (const segment of letters) {
      if (line && measure(line + segment, size, bold) > width) {
        lines.push(line);
        line = '';
      }
      line += segment;
    }
  }
  if (line) lines.push(line);
  return lines;
}

const xmlText = (value: string) =>
  escapeSvg(
    // XML disallows control characters even inside escaped text.
    // oxlint-disable-next-line eslint/no-control-regex
    value.replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, ''),
  );

function text(value: string, x: number, y: number, size: number, color: string, bold = false) {
  return `<text x="${x}" y="${y}" fill="${color}" font-size="${size}"${bold ? ' font-weight="700"' : ''}>${xmlText(value)}</text>`;
}

/** The same canonical coordinates and recorded result facts as the public draw. */
export function bracketGraphicSvg(
  context: BracketGraphicContext,
  matches: LiveMatch[],
  measure: Measure,
): BracketGraphicImage | null {
  if (!hasExportableBracket(matches)) return null;
  const labels = new Map(matches.map(({ id, label }) => [id, label]));
  const lanes = liveBracketLanes(matches);
  const laneByMatch = new Map(
    lanes.flatMap((lane) => lane.matches.map(({ id }) => [id, lane.key])),
  );
  const closed = context.state === 'closed';
  const wrap = (value: string, size: number, bold = false, width = cardWidth - 24) =>
    wrapText(value, width, size, bold, measure);
  const layouts = lanes.map((lane) => {
    const cards = new Map(
      lane.matches.map((match) => {
        const status =
          !closed && isUntakenCall(match, true) ? 'Called' : liveBracketStatus(match, closed);
        const label =
          match.bracketLane === 'reset' && match.status === 'complete'
            ? 'Reset final'
            : match.label;
        const heading = wrap(`${label} · ${status}`, 14, true);
        const scores = match.status === 'complete' && matchPresentation(match, true).showScores;
        const rows = ([0, 1] as const).map((side) => {
          const id = side === 0 ? match.player1Id : match.player2Id;
          const score = scores ? (side === 0 ? match.score1 : match.score2) : null;
          const winner = liveBracketWinner(match, id);
          const name = wrap(liveBracketSide(match, side, labels), 17, winner, cardWidth - 74);
          const feed = liveBracketFeeds(match).find((edge) => edge.side === side);
          const origin =
            feed && id && laneByMatch.get(feed.matchId) !== lane.key
              ? wrap(
                  `${feed.outcome === 'winner' ? 'Winner' : 'Loser'} of ${labels.get(feed.matchId)}`,
                  13,
                )
              : [];
          return {
            score,
            winner,
            name,
            origin,
            height: 11 + lineHeight * name.length + 17 * origin.length,
          };
        });
        const headerHeight = 12 + 18 * heading.length;
        return [
          match.id,
          { heading, rows, headerHeight, height: headerHeight + rows[0]!.height + rows[1]!.height },
        ];
      }),
    );
    const height = Math.max(...[...cards.values()].map((card) => card.height));
    const port = (match: LiveMatch, side: number) => {
      const card = cards.get(match.id)!;
      return (
        card.headerHeight + (side === 0 ? 0 : card.rows[0]!.height) + card.rows[side]!.height / 2
      );
    };
    const layout = eliminationLaneLayout(
      lane.matches,
      lane.key,
      {
        id: (match) => match.id,
        round: liveBracketRound,
        slot: (match) => match.nativeSlot!,
        feeds: liveBracketFeeds,
        targetPort: port,
        sourcePort: (match, outcome) => {
          const side = liveBracketSourceSide(match, outcome);
          return side === null ? cards.get(match.id)!.height / 2 : port(match, side);
        },
      },
      { width: cardWidth, height, column: cardWidth + 42, row: height + 14, top: 52 },
    );
    return { lane, layout, cards };
  });
  if (!layouts.length) return null;
  const width = Math.max(790, ...layouts.map(({ layout }) => layout.width + padding * 2));
  const title = wrap(context.eventName, 34, true, width - padding * 2);
  const state = {
    published: 'Published draw snapshot',
    paused: 'Draw paused',
    closed: 'Recorded draw',
  }[context.state];
  const scope = wrap(
    `${context.scope} · ${context.format === 'doubles' ? 'Doubles' : 'Singles'} · ${state}${context.eventDate ? ` · ${context.eventDate}` : ''}`,
    17,
    false,
    width - padding * 2,
  );
  const laneHeight = layouts.reduce((total, { layout }) => total + layout.height + 22, 0);
  if (laneHeight + 118 + title.length * 40 + scope.length * 23 > 150_000) return null;
  let y = 65;
  const header = title
    .map((line) => text(line, padding, (y += 40), 34, colors.text, true))
    .join('');
  const subtitle = scope.map((line) => text(line, padding, (y += 23), 17, colors.muted)).join('');
  y += 27;
  const sections = layouts
    .map(({ lane, layout, cards }) => {
      const offset = y;
      y += layout.height + 22;
      const onlyGrandFinal =
        lane.key === 'finals' && !lane.matches.some(({ bracketLane }) => bracketLane === 'reset');
      const laneTitle = onlyGrandFinal ? 'Grand final' : lane.title || 'Elimination bracket';
      const heading = text(laneTitle, 12, 20, 22, colors.text, true);
      const rounds = layout.rounds
        .map(({ x, label }, index) => {
          const playedReset =
            lane.key === 'finals' &&
            index === 1 &&
            lane.matches.some(
              (match) => match.bracketLane === 'reset' && match.status === 'complete',
            );
          const roundTitle = playedReset
            ? 'Reset'
            : lane.title
              ? label
              : index === layout.rounds.length - 1
                ? 'Final'
                : index === layout.rounds.length - 2
                  ? 'Semi-finals'
                  : label;
          return text(roundTitle, x, 42, 15, colors.muted, true);
        })
        .join('');
      const edges = layout.edges
        .map(
          (edge) =>
            `<path d="${edge.path}" fill="none" stroke="${edge.outcome === 'loser' ? colors.gold : colors.muted}" stroke-width="1.5"${edge.outcome === 'loser' ? ' stroke-dasharray="5 4"' : ''}/>`,
        )
        .join('');
      const nodes = layout.nodes
        .map(({ match, x, y: top }) => {
          const card = cards.get(match.id)!;
          let rowY = card.headerHeight;
          const rows = card.rows
            .map((row) => {
              const start = rowY;
              rowY += row.height;
              const color = row.winner ? colors.gold : colors.text;
              const names = row.name
                .map((line, index) =>
                  text(line, 12, start + 21 + lineHeight * index, 17, color, row.winner),
                )
                .join('');
              const origin = row.origin
                .map((line, index) =>
                  text(
                    line,
                    12,
                    start + lineHeight * row.name.length + 15 + 17 * index,
                    13,
                    colors.muted,
                  ),
                )
                .join('');
              const score =
                row.score === null
                  ? ''
                  : text(String(row.score), cardWidth - 42, start + 21, 17, color, true);
              return `<path d="M0 ${start}H${cardWidth}" stroke="${colors.divider}"/>${row.winner ? `<rect y="${start + 1}" width="3" height="${row.height - 1}" fill="${colors.gold}"/>` : ''}${names}${origin}${score}`;
            })
            .join('');
          return `<g transform="translate(${x} ${top})"><rect width="${cardWidth}" height="${card.height}" fill="${colors.card}" stroke="${colors.divider}"/>${card.heading.map((line, index) => text(line, 12, 20 + 18 * index, 14, colors.muted, true)).join('')}${rows}</g>`;
        })
        .join('');
      return `<g transform="translate(${padding} ${offset})">${heading}${rounds}${edges}${nodes}</g>`;
    })
    .join('');
  const height = Math.ceil(y + 26);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img"><title>${xmlText(`${context.eventName} · ${context.scope}`)}</title><desc>Smash Club bracket. Gold marks the recorded winner. Dashed lines are loser feeds. Scores shown are recorded results.</desc><rect width="${width}" height="${height}" fill="${colors.background}"/><rect width="8" height="${height}" fill="${colors.red}"/><g font-family="${font}"><g fill="${colors.red}" transform="translate(${padding} 21) scale(.28)"><path d="${NEMESIS_MARK_PATHS[0]}"/><path d="${NEMESIS_MARK_PATHS[1]}" opacity=".45"/></g>${text('NEMESIS / SMASH CLUB', padding + 40, 42, 17, colors.red, true)}${header}${subtitle}${sections}${text('Gold marks the recorded winner · Dashed lines are loser feeds', padding + 12, height - 24, 15, colors.muted)}</g></svg>`;
  return { svg, width, height };
}

export function browserBracketGraphic(context: BracketGraphicContext, matches: LiveMatch[]) {
  const canvas = document.createElement('canvas').getContext('2d');
  return bracketGraphicSvg(context, matches, (value, size, bold) => {
    if (!canvas) return Array.from(value).length * size;
    canvas.font = `${bold ? 700 : 400} ${size}px ${font}`;
    return canvas.measureText(value).width;
  });
}

export function bracketPngScale({ width, height }: BracketGraphicImage) {
  return Math.min(2, 4096 / Math.max(width, height), Math.sqrt(12_000_000 / (width * height)));
}

export async function bracketGraphicPng(graphic: BracketGraphicImage, blob: Blob) {
  const scale = bracketPngScale(graphic);
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(graphic.width * scale);
    canvas.height = Math.floor(graphic.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}
