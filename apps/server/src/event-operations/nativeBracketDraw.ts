import { standardBracketOrder } from '@smashclub/engine';

/** The seed geometry used by native SQL brackets, including padded byes. */
export function nativeBracketDraw(entrantIds: readonly string[]) {
  let size = 2;
  while (size < entrantIds.length) size *= 2;
  return entrantIds.length
    ? standardBracketOrder(size).map((seed) => entrantIds[seed - 1] ?? null)
    : [];
}
