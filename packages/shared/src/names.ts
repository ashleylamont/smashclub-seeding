/**
 * The public alias a player falls back to when they have not chosen one:
 * their first name, then an initial for each name after it.
 *
 *   "Sample Player"      -> "Sample P"
 *   "Mary Jane Watson"   -> "Mary J W"
 *   "Vincent"            -> "Vincent"   (nothing follows, so nothing to shorten)
 *
 * This is deliberately the same shape the identity matcher already reads as a
 * structured alias (first name + initial, see `resolveStructuredAlias`), so a
 * defaulted alias still resolves against bracket entries rather than becoming
 * a name nothing can match.
 *
 * Case is preserved rather than upper-cased: canonical names are already
 * cased, and forcing upper would mangle particles ("Ludwig van Beethoven" ->
 * "Ludwig v B", not "Ludwig V B").
 */
export function defaultPublicAlias(canonicalName: string): string {
  const parts = canonicalName.trim().split(/\s+/).filter(Boolean);
  const [first, ...rest] = parts;
  if (first === undefined) return canonicalName.trim();
  if (rest.length === 0) return first;
  // Spread to codepoints so a non-BMP initial is not split into half a pair.
  return [first, ...rest.map((part) => [...part][0]!)].join(' ');
}

/**
 * The name to show publicly for a player: their chosen alias if they set one,
 * otherwise the shortened form of their canonical name. Admin surfaces
 * deliberately do not use this — they show the canonical name in full.
 */
export function publicPlayerName(row: { displayName: string | null; canonicalName: string }): string {
  return row.displayName ?? defaultPublicAlias(row.canonicalName);
}
