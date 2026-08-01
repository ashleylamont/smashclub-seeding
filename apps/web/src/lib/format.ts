/** Small formatting helpers shared across pages. */

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "3 minutes ago" style relative timestamp. */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'never';
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.round(months / 12);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

/**
 * League tier as an ordinal class, highest first. Leagues are a ranked ladder,
 * so they get one colour ramp rather than four unrelated hues.
 */
export function tierClass(league: string): string {
  if (league.includes('Champions')) return 'tier-1';
  if (league.includes('Full-Timers')) return 'tier-2';
  if (league.includes('Grads')) return 'tier-3';
  return 'tier-4';
}

/** Bracket round label: winners rounds are positive, losers negative. */
export function roundLabel(round: number): string {
  return round >= 0 ? `W${round}` : `L${-round}`;
}

/**
 * A scoreline read from the winner's side.
 *
 * Challonge reports `scores_csv` player-one-first, so a set player two won
 * arrives as "1-2". Anywhere the winner is named first — a results ticker, a
 * result card — printing that verbatim reads as though the winner lost. Flip
 * each game's pair when player two won.
 *
 * Returns null for a score that cannot be read, which includes Challonge's
 * negative-number forfeit convention; a walkover has no scoreline to show.
 */
export function orientScore(scoresCsv: string | null | undefined, winnerSide: number | null): string | null {
  if (!scoresCsv || (winnerSide !== 1 && winnerSide !== 2)) return null;
  const games: string[] = [];
  for (const part of scoresCsv.split(',')) {
    const match = part.trim().match(/^(-?\d+)-(-?\d+)$/);
    if (!match) return null;
    const a = Number(match[1]);
    const b = Number(match[2]);
    if (a < 0 || b < 0) return null;
    games.push(winnerSide === 1 ? `${a}-${b}` : `${b}-${a}`);
  }
  return games.length > 0 ? games.join(', ') : null;
}
