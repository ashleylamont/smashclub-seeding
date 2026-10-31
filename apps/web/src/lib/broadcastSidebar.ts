import type { ResultMatch } from './broadcastResults';

/** Bounded for the narrow OBS rail, including the venue guest QR at 720p. */
export function recentResultCount(search: string) {
  const raw = new URLSearchParams(search).get('recent');
  const count = raw?.trim() ? Number(raw) : 2;
  return Number.isFinite(count) ? Math.max(1, Math.min(2, Math.floor(count))) : 2;
}

export function resultStageLabel(match: ResultMatch) {
  const division =
    match.division === 'upper' ? 'Upper' : match.division === 'lower' ? 'Lower' : match.division;
  return match.stage === 'group'
    ? `${division} · Pool ${String.fromCharCode(65 + (match.poolIndex ?? 0))}`
    : `${division} · ${match.stage === 'main' ? 'Championship' : 'Consolation'} · ${match.label}`;
}
