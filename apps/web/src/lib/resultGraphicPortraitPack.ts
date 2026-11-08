import { CHARACTERS, isCharacterSlug } from '@smashclub/shared';
import { graphicMemberKey, graphicMembers, type GraphicResult } from './resultGraphic';
import type { GraphicPortraits } from './resultGraphicPng';
import { readResultPortrait, validateResultPortrait } from './resultGraphicPortrait';

export type CharacterPortraitPack = ReadonlyMap<string, File>;

const PACK_MAX_BYTES = 120 * 1024 * 1024;
const PACK_PORTRAIT_EDGE = 640;

export function characterPortraitPack(files: readonly File[]): CharacterPortraitPack {
  if (files.length > CHARACTERS.length) throw new Error('Choose at most one image per character.');
  if (files.reduce((total, file) => total + file.size, 0) > PACK_MAX_BYTES)
    throw new Error('Choose artwork files totalling at most 120 MB.');

  const pack = new Map<string, File>();
  for (const file of files) {
    const slug = /^([a-z0-9-]+)\.(?:png|jpe?g|webp)$/i.exec(file.name)?.[1]?.toLowerCase();
    if (!slug || !isCharacterSlug(slug))
      throw new Error(`“${file.name}” needs a character filename like mario.png.`);
    if (pack.has(slug)) throw new Error(`Choose only one artwork file for ${slug}.`);
    try {
      validateResultPortrait(file);
    } catch (error) {
      throw new Error(`“${file.name}” could not be added. ${(error as Error).message}`, {
        cause: error,
      });
    }
    pack.set(slug, file);
  }
  return pack;
}

export async function resolveCharacterPortraits(
  rows: readonly GraphicResult[],
  individual: GraphicPortraits,
  pack: CharacterPortraitPack,
  bundledCache: Map<string, HTMLCanvasElement | null>,
  signal: AbortSignal,
) {
  const keysByCharacter = new Map<string, string[]>();
  rows.forEach((row, rowIndex) =>
    graphicMembers(row).forEach(({ character }, index) => {
      const key = graphicMemberKey(row, rowIndex, index);
      if (!character || !isCharacterSlug(character) || individual[key]) return;
      const keys = keysByCharacter.get(character);
      if (keys) keys.push(key);
      else keysByCharacter.set(character, [key]);
    }),
  );

  const portraits = { ...individual };
  const bundled = new Set<string>();
  const pending: [string, string[]][] = [];
  let applied = 0;
  let unreadable = 0;
  for (const [character, keys] of keysByCharacter) {
    if (signal.aborted) break;
    const file = pack.get(character);
    if (file) {
      try {
        // Decode one used local file at a time and reuse it for matching panels.
        const portrait = await readResultPortrait(file, PACK_PORTRAIT_EDGE);
        for (const key of keys) portraits[key] = portrait;
        applied += keys.length;
        continue;
      } catch {
        unreadable++;
      }
    }
    pending.push([character, keys]);
  }

  if (pending.length && !signal.aborted) {
    const source = await import('./resultGraphicBundledArt').catch(() => null);
    if (!source || signal.aborted) return { portraits, bundled, applied, unreadable };
    const request = new AbortController();
    const stop = () => request.abort();
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    const timeout = window.setTimeout(stop, 6000);
    let next = 0;
    const load = async () => {
      while (!request.signal.aborted && next < pending.length) {
        const [slug, keys] = pending[next++]!;
        let portrait = bundledCache.get(slug);
        if (portrait === undefined) {
          portrait = (await source.loadBundledResultPortrait(slug, request.signal)) ?? null;
          if (request.signal.aborted) return;
          bundledCache.set(slug, portrait);
        }
        if (!portrait) continue;
        for (const key of keys) {
          portraits[key] = portrait;
          bundled.add(key);
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(4, pending.length) }, load));
    } finally {
      window.clearTimeout(timeout);
      signal.removeEventListener('abort', stop);
    }
  }
  return { portraits, bundled, applied, unreadable };
}
