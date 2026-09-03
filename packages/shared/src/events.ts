export interface EventBracketRole {
  division: 'upper' | 'lower';
  stage: 'main' | 'consolation';
}

/** Only explicit format labels imply a division; unrelated names stay separate. */
export function inferEventBracketRole(name: string): EventBracketRole | null {
  const upper = /\bupper\b/i.test(name);
  const lower = /\blower\b/i.test(name);
  if (upper === lower) return null;
  const stage = /\b(?:losers?|consolation)\b/i.test(name) ? 'consolation' :
    /\b(?:main|division|championship)\b/i.test(name) ? 'main' : null;
  return stage ? { division: upper ? 'upper' : 'lower', stage } : null;
}

/** Strip bracket suffixes only when every bracket shares the same event title. */
export function eventNameOf(names: readonly string[]): string {
  const clean = (name: string) => name.trim()
    .replace(/\s*\((?:(?:upper|lower)\s+)?(?:division|main|championship|losers?|consolation|rookies?)\)\s*$/i, '')
    .replace(/\s*(?:[-–—:]\s*)?(?:upper|lower)\s+(?:division|main|championship|losers?|consolation)\s*$/i, '')
    .replace(/\s+(?:rookies?|main|consolation)\s*$/i, '').trim();
  const bases = names.map(clean).filter(Boolean);
  if (!bases.length) return 'Club night';
  if (bases.every((name) => name.toLowerCase() === bases[0]!.toLowerCase())) return bases[0]!;
  return names.length === 1 ? names[0]!.trim() : 'Club night';
}

export interface EventBracketReference {
  slug: string;
  name?: string;
  isRookie?: boolean;
  division?: string | null;
  stage?: string | null;
}

export function compareEventBrackets(a: EventBracketReference, b: EventBracketReference): number {
  const rank = (row: EventBracketReference) => {
    const role = row.division && row.stage ? row : inferEventBracketRole(row.name ?? '');
    if (role) return (role.division === 'upper' ? 0 : 2) + (role.stage === 'consolation' ? 1 : 0);
    return row.isRookie ? 11 : 10;
  };
  return rank(a) - rank(b) || (a.name ?? a.slug).localeCompare(b.name ?? b.slug) || a.slug.localeCompare(b.slug);
}

/** Independent of the bracket URL used to enter the event. */
export function eventCanonicalSlug(rows: readonly EventBracketReference[], fallback: string): string {
  return [...rows].sort(compareEventBrackets)[0]?.slug ?? fallback;
}
