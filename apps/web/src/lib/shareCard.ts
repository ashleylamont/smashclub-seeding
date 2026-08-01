/**
 * Renders a night's recap as a PNG for sharing.
 *
 * Drawn on a canvas rather than rasterised from the DOM: the card is a fixed
 * scoreboard layout, not a screenshot of the page, and drawing it directly
 * avoids pulling in a DOM-to-image dependency along with its font and CSS
 * caveats. The palette is read from the live CSS custom properties, so the
 * image matches whichever theme the sharer is looking at.
 */

/** Open Graph's 1.91:1, which is what chat clients crop to. */
const WIDTH = 1200;
const HEIGHT = 630;
const PAD = 64;

export interface ShareCardInput {
  title: string;
  date: string;
  podium: Array<{ place: number; name: string; companyCode: string | null }>;
  /** A couple of headlines from the night, already formatted. */
  facts: string[];
  entrants: number;
  setsPlayed: number;
}

function token(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * Cut text to fit `maxWidth`, ending in an ellipsis. Canvas has no equivalent
 * of `text-overflow`, and an over-long club name would otherwise run off the
 * edge of the card.
 */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) {
    cut = cut.slice(0, -1);
  }
  return `${cut.trimEnd()}…`;
}

/**
 * Wait for the webfonts the card draws with. Canvas silently falls back to a
 * default face for a font that has not loaded yet, so without this the first
 * share of a session renders in the wrong typeface.
 */
async function ensureFonts(): Promise<void> {
  const faces = ['700 72px Oswald', '600 34px Oswald', '400 22px "JetBrains Mono"', '700 22px "JetBrains Mono"'];
  try {
    await Promise.all(faces.map((face) => document.fonts.load(face)));
    await document.fonts.ready;
  } catch {
    // Fonts are a nicety here; a card in a fallback face still beats no card.
  }
}

export async function renderShareCard(input: ShareCardInput): Promise<Blob | null> {
  await ensureFonts();

  const canvas = document.createElement('canvas');
  // Render at 2x so the text stays crisp when a chat client scales it up.
  const scale = 2;
  canvas.width = WIDTH * scale;
  canvas.height = HEIGHT * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(scale, scale);

  const bg = token('--bg', '#07090a');
  const surface = token('--surface', '#0f1213');
  const textH = token('--text-h', '#f1f0ee');
  const text = token('--text', '#9a9895');
  const soft = token('--text-soft', '#64625f');
  const accent = token('--accent', '#ff3b30');
  const border = token('--border', '#24262a');

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // The one red, as a hard edge down the left — the same device the app uses
  // for an active row.
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, 10, HEIGHT);

  ctx.textBaseline = 'alphabetic';

  // Eyebrow.
  ctx.font = '700 22px "JetBrains Mono", monospace';
  ctx.fillStyle = accent;
  ctx.fillText('SMASH CLUB — THE NIGHT IN REVIEW', PAD, PAD + 22);

  // Title.
  ctx.font = '700 72px Oswald, sans-serif';
  ctx.fillStyle = textH;
  ctx.fillText(fitText(ctx, input.title.toUpperCase(), WIDTH - PAD * 2), PAD, PAD + 108);

  // Date.
  ctx.font = '400 22px "JetBrains Mono", monospace';
  ctx.fillStyle = soft;
  ctx.fillText(input.date, PAD, PAD + 146);

  ctx.fillStyle = border;
  ctx.fillRect(PAD, PAD + 176, WIDTH - PAD * 2, 2);

  // Podium — the headline of any recap.
  let y = PAD + 240;
  const placeColours = [accent, textH, text];
  for (const entry of input.podium.slice(0, 3)) {
    const index = entry.place - 1;
    ctx.font = '700 48px Oswald, sans-serif';
    ctx.fillStyle = placeColours[index] ?? text;
    ctx.fillText(`${entry.place}`, PAD, y);

    ctx.font = '600 34px Oswald, sans-serif';
    ctx.fillStyle = index === 0 ? textH : text;
    const name = entry.companyCode ? `${entry.name}  ${entry.companyCode}` : entry.name;
    ctx.fillText(fitText(ctx, name.toUpperCase(), 520), PAD + 56, y);
    y += 56;
  }

  // Facts, in a column beside the podium.
  const factX = PAD + 620;
  let factY = PAD + 214;
  ctx.font = '700 18px "JetBrains Mono", monospace';
  ctx.fillStyle = soft;
  ctx.fillText('HIGHLIGHTS', factX, factY);
  factY += 34;
  ctx.font = '400 22px "JetBrains Mono", monospace';
  for (const fact of input.facts.slice(0, 4)) {
    ctx.fillStyle = accent;
    ctx.fillText('▸', factX, factY);
    ctx.fillStyle = text;
    ctx.fillText(fitText(ctx, fact, WIDTH - factX - PAD - 28), factX + 28, factY);
    factY += 40;
  }

  // Footer strip.
  ctx.fillStyle = surface;
  ctx.fillRect(0, HEIGHT - 76, WIDTH, 76);
  ctx.fillStyle = border;
  ctx.fillRect(0, HEIGHT - 76, WIDTH, 1);
  ctx.font = '400 22px "JetBrains Mono", monospace';
  ctx.fillStyle = soft;
  ctx.fillText(
    `${input.entrants} entrants · ${input.setsPlayed} sets`,
    PAD,
    HEIGHT - 30,
  );
  const host = window.location.host;
  const hostWidth = ctx.measureText(host).width;
  ctx.fillText(host, WIDTH - PAD - hostWidth, HEIGHT - 30);

  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'));
}

/** Save a rendered card to the user's downloads. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking synchronously can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
