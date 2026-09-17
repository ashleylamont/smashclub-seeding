export interface LiveMatch {
  id: string; division: string; stage: string; poolIndex: number | null; label: string;
  player1Name: string | null; player2Name: string | null; player1Id: string | null; player2Id: string | null;
  score1: number | null; score2: number | null; winnerId: string | null;
  status: string; stationId: string | null;
}
export function liveSections(matches: readonly LiveMatch[]) {
  return { playing: matches.filter(m => m.status === 'playing'), ready: matches.filter(m => m.status === 'ready'),
    complete: matches.filter(m => m.status === 'complete'), total: matches.length };
}
/** Percentages of the browser source: reserve a transparent, centred capture region. */
export function overlayGeometry(search: string) {
  const params = new URLSearchParams(search);
  const bounded = (key: string, fallback: number, min: number, max: number) => {
    const raw = params.get(key);
    const value = raw === null || raw.trim() === '' ? fallback : Number(raw);
    return Math.min(max, Math.max(min, Number.isFinite(value) ? value : fallback));
  };
  return { width: bounded('captureWidth', 68, 35, 85), height: bounded('captureHeight', 65, 30, 80) };
}
