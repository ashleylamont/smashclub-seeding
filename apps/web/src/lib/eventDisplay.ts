import { availableMatches } from './eventQueue';
export interface LiveMatch {
  id: string; division: string; stage: string; poolIndex: number | null; label: string;
  player1Name: string | null; player2Name: string | null; player1Id: string | null; player2Id: string | null;
  score1: number | null; score2: number | null; winnerId: string | null;
  status: string; stationId: string | null;
  outcome?: string | null;
  blockedReason?: string | null;
  player1Characters?: string[]; player2Characters?: string[];
  availability?: { canStart: boolean; reasons: { code: string; message: string }[]; eligibleStationIds: string[] };
  nativeBracketId?: string | null; nativeRound?: number | null; nativeSlot?: number | null;
  parent1MatchId?: string | null; parent2MatchId?: string | null;
}
export function liveSections(matches: readonly LiveMatch[]) {
  return { playing: matches.filter(m => m.status === 'playing'), ready: availableMatches(matches).filter(match => match.availability?.canStart !== false),
    complete: matches.filter(m => m.status === 'complete'), total: matches.length };
}
/** Percentages of the browser source: reserve a transparent aperture inside the 20% rail and 13% header. */
export function overlayGeometry(search: string) {
  const params = new URLSearchParams(search);
  const bounded = (key: string, fallback: number, min: number, max: number) => {
    const raw = params.get(key);
    const value = raw === null || raw.trim() === '' ? fallback : Number(raw);
    return Math.min(max, Math.max(min, Number.isFinite(value) ? value : fallback));
  };
  return { width: bounded('captureWidth', 78, 35, 78), height: bounded('captureHeight', 78, 30, 78) };
}

/** Pick distinct challengers, preserving readiness priority without promising the same player twice. */
export function broadcastQueue(matches: readonly LiveMatch[], limit = 3): LiveMatch[] {
  const selected: LiveMatch[] = [];
  const used = new Set<string>();
  for (const match of matches) {
    if (selected.length >= limit) break;
    if (!match.player1Id || !match.player2Id || used.has(match.player1Id) || used.has(match.player2Id)) continue;
    selected.push(match);
    used.add(match.player1Id);
    used.add(match.player2Id);
  }
  return selected;
}
