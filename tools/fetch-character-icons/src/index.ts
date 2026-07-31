/* eslint-disable no-restricted-globals */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { CHARACTERS, type Character } from '@smashclub/shared';

/**
 * Download SSBU head icons into apps/web/public/characters/<slug>.png.
 *
 * Run once (or after a roster addition):
 *
 *   pnpm --filter @smashclub/fetch-character-icons start
 *
 * The wiki's file names are not something to hardcode a guess at — they change
 * and they are inconsistent — so this asks the MediaWiki API for the category's
 * actual members, normalises each title, and matches it against the roster.
 * Anything it cannot match is reported rather than silently skipped, and the UI
 * falls back to a text badge for any icon that never arrives.
 *
 * These are Nintendo's assets, used here the way every other fan bracket site
 * uses them. They are deliberately not committed to the repository.
 */

const API = 'https://www.ssbwiki.com/api.php';
const CATEGORY = 'Category:Head icons (SSBU)';

const outputDir = fileURLToPath(new URL('../../../apps/web/public/characters/', import.meta.url));

interface ImageInfo {
  title: string;
  url: string;
}

async function api(params: Record<string, string>): Promise<unknown> {
  const url = new URL(API);
  for (const [key, value] of Object.entries({ ...params, format: 'json', formatversion: '2' })) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    // The wiki blocks requests without a descriptive agent.
    headers: { 'User-Agent': 'smashclub-seeding icon fetcher (one-off, https://github.com/ashleylamont/smashclub-seeding)' },
  });
  if (!response.ok) throw new Error(`${url.pathname}${url.search} -> ${response.status} ${response.statusText}`);
  return response.json();
}

/** Every file in the head-icon category, with a direct download URL. */
async function listCategoryImages(): Promise<ImageInfo[]> {
  const images: ImageInfo[] = [];
  let cont: string | undefined;

  do {
    const page = (await api({
      action: 'query',
      generator: 'categorymembers',
      gcmtitle: CATEGORY,
      gcmtype: 'file',
      gcmlimit: '500',
      prop: 'imageinfo',
      iiprop: 'url',
      ...(cont ? { gcmcontinue: cont } : {}),
    })) as {
      query?: { pages?: Array<{ title: string; imageinfo?: Array<{ url: string }> }> };
      continue?: { gcmcontinue?: string };
    };

    for (const page_ of page.query?.pages ?? []) {
      const url = page_.imageinfo?.[0]?.url;
      if (url) images.push({ title: page_.title, url });
    }
    cont = page.continue?.gcmcontinue;
  } while (cont);

  return images;
}

/**
 * Strip everything that varies between a wiki file name and a character name —
 * the File: prefix, the Head/SSBU/Icon decorations, punctuation and case — so
 * "File:HeadSSBUDarkSamus.png" and "Dark Samus" both reduce to "darksamus".
 */
function normalize(text: string): string {
  return text
    .replace(/^File:/i, '')
    .replace(/\.(png|jpg|jpeg|gif|svg)$/i, '')
    .replace(/head|icon|ssbu|stock/gi, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
}

/** All the spellings a character might appear under, normalised. */
function keysFor(character: Character): string[] {
  return [character.name, character.slug, ...(character.aka ?? [])].map(normalize);
}

async function main(): Promise<void> {
  console.log(`Listing ${CATEGORY} …`);
  const images = await listCategoryImages();
  console.log(`  ${images.length} files in the category.`);

  const byKey = new Map<string, ImageInfo>();
  for (const image of images) {
    const key = normalize(image.title);
    // First match wins: the category also holds recoloured and variant icons
    // whose names extend the base one, and the plain icon sorts first.
    if (!byKey.has(key)) byKey.set(key, image);
  }

  await mkdir(outputDir, { recursive: true });

  const missing: string[] = [];
  let written = 0;

  for (const character of CHARACTERS) {
    const match = keysFor(character)
      .map((key) => byKey.get(key))
      .find(Boolean);

    if (!match) {
      missing.push(character.name);
      continue;
    }

    const response = await fetch(match.url, {
      headers: { 'User-Agent': 'smashclub-seeding icon fetcher (one-off)' },
    });
    if (!response.ok) {
      console.warn(`  ! ${character.name}: ${response.status} ${response.statusText}`);
      missing.push(character.name);
      continue;
    }
    await writeFile(`${outputDir}${character.slug}.png`, Buffer.from(await response.arrayBuffer()));
    written += 1;
    console.log(`  ✓ ${character.name} -> ${character.slug}.png`);
  }

  console.log(`\n${written}/${CHARACTERS.length} icons written to apps/web/public/characters/.`);
  if (missing.length > 0) {
    console.log(
      `Unmatched (add an \`aka\` spelling in packages/shared/src/characters.ts, or drop the file in by hand):\n  ${missing.join(', ')}`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
