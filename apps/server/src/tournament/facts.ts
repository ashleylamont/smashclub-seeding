import { createHash } from 'node:crypto';
import type { Match } from './schemas';

export class TournamentConflict extends Error {}
export function requireFact(value: unknown, message: string): asserts value {
  if (!value) throw new TournamentConflict(message);
}
export function stableId(value: string): string {
  const hex = createHash('sha256').update(value).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export const hash = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
export const receiptKey = (actorId: string, requestId: string) => hash([actorId, requestId]);

export const sameScore = (
  a: Pick<Match, 'outcome' | 'score1' | 'score2' | 'winnerId'>,
  b: Pick<Match, 'outcome' | 'score1' | 'score2' | 'winnerId'>,
) =>
  a.outcome === b.outcome &&
  a.score1 === b.score1 &&
  a.score2 === b.score2 &&
  a.winnerId === b.winnerId;
export const resolved = (match: Match) => match.status === 'complete';
