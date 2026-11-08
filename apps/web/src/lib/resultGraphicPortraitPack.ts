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
  signal: AbortSignal,
) {
  const keysByCharacter = new Map<string, string[]>();
  if (pack.size)
    rows.forEach((row, rowIndex) =>
      graphicMembers(row).forEach(({ character }, index) => {
        const key = graphicMemberKey(row, rowIndex, index);
        if (!character || individual[key] || !pack.has(character)) return;
        const keys = keysByCharacter.get(character);
        if (keys) keys.push(key);
        else keysByCharacter.set(character, [key]);
      }),
    );

  const portraits = { ...individual };
  let applied = 0;
  let unreadable = 0;
  for (const [character, keys] of keysByCharacter) {
    if (signal.aborted) break;
    try {
      // Decode one used file at a time and reuse it for every matching panel.
      const portrait = await readResultPortrait(pack.get(character)!, PACK_PORTRAIT_EDGE);
      for (const key of keys) portraits[key] = portrait;
      applied += keys.length;
    } catch {
      unreadable++;
    }
  }
  return { portraits, applied, unreadable };
}
