import type { trpc } from './trpc';

export type BreakthroughData = NonNullable<Awaited<ReturnType<typeof trpc.admin.breakthrough.query>>>;
export type BreakthroughPlayer = BreakthroughData['rows'][number];

export const breakthroughDefaults = { priorNights: 2, priorSets: 8, nightSets: 3, opponents: 3, smoothing: 3 };
export function breakthroughSearch(search: Record<string, unknown>) {
  const number = (key: keyof typeof breakthroughDefaults, max: number) => {
    const n = Number(search[key] ?? breakthroughDefaults[key]);
    return Number.isInteger(n) && n >= 0 && n <= max ? n : breakthroughDefaults[key];
  };
  return {
    event: typeof search.event === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(search.event) &&
      Number.isFinite(Date.parse(search.event)) && new Date(search.event).toISOString().slice(0, 10) === search.event ? search.event : '',
    priorNights: number('priorNights', 20), priorSets: number('priorSets', 100),
    nightSets: number('nightSets', 30), opponents: number('opponents', 30), smoothing: number('smoothing', 20),
    sort: search.sort === 'surplus' ? 'surplus' as const : 'adjusted' as const,
    showAll: search.showAll !== false && search.showAll !== 'false',
  };
}
export type BreakthroughOptions = ReturnType<typeof breakthroughSearch>;

export function summariseBreakthrough(row: BreakthroughPlayer, options: BreakthroughOptions) {
  const assessed = row.sets.filter((s) => s.expected !== null);
  const wins = row.sets.filter((s) => s.won).length;
  const assessedWins = assessed.filter((s) => s.won).length;
  const expected = assessed.reduce((sum, s) => sum + s.expected!, 0);
  const surplus = assessedWins - expected;
  const opponents = new Set(assessed.map((s) => s.opponentId)).size;
  const adjusted = assessed.length ? 100 * surplus / (assessed.length + options.smoothing) : null;
  const strongest = assessed.length ? Math.max(...assessed.map((s) => Number(s.won) - s.expected!)) : 0;
  const withoutBest = assessed.length > 1 ? 100 * (surplus - strongest) / (assessed.length - 1 + options.smoothing) : null;
  const reasons: string[] = [];
  if (!row.baseline) reasons.push('No pre-night history');
  if (row.priorNights < options.priorNights) reasons.push(`${row.priorNights}/${options.priorNights} prior nights`);
  if (row.priorSets < options.priorSets) reasons.push(`${row.priorSets}/${options.priorSets} prior sets`);
  if (!assessed.length) reasons.push('No comparable sets');
  else if (assessed.length < options.nightSets) reasons.push(`${assessed.length}/${options.nightSets} comparable sets`);
  if (opponents < options.opponents) reasons.push(`${opponents}/${options.opponents} comparable opponents`);
  return { wins, losses: row.sets.length - wins, assessed: assessed.length, assessedWins, expected, surplus,
    opponents, adjusted, withoutBest, reasons, meetsCriteria: reasons.length === 0,
    unassessed: row.sets.length - assessed.length,
    thinOpponents: new Set(assessed.filter((s) => s.opponentPriorNights < 2).map((s) => s.opponentId)).size };
}
