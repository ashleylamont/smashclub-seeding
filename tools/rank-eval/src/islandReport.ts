/**
 * Rookie-island report: what the rookie-debut prior and the isolation anchor
 * actually do, on real data.
 *
 * Usage:
 *   pnpm tsx src/islandReport.ts <engine-input.json> [rookieDebutPrior]
 *
 * The input file is {tournaments, sets, names} in engine shapes (see the
 * fetch script that produced it). Two reports:
 *
 *  1. Cross-bracket walk-forward — out-of-sample predictions restricted to the
 *     sets where the inflation would show: a rookie-only player against
 *     someone with main-bracket experience.
 *  2. Board diff — the current leaderboard versus the recalibrated one.
 */
import { readFileSync } from 'node:fs';
import {
  runWhrModel,
  whrModel,
  type EngineSet,
  type EngineTournament,
  type EvalSet,
} from '@smashclub/engine';
import { defaultGlickoSettings } from '@smashclub/shared';

const inputPath = process.argv[2];
if (!inputPath) throw new Error('usage: tsx src/islandReport.ts <engine-input.json> [rookieDebutPrior]');
const rookieDebutPrior = Number(process.argv[3] ?? 1400);

const payload = JSON.parse(readFileSync(inputPath, 'utf8')) as {
  tournaments: Array<EngineTournament & { name: string }>;
  sets: EngineSet[];
  names: Record<string, string>;
};
const nameOf = (id: string): string => payload.names[id] ?? id.slice(0, 8);
const rookieById = new Map(payload.tournaments.map((t) => [t.id, t.isRookie]));

// ---- 1. cross-bracket walk-forward ----

const origin = Math.min(...payload.tournaments.map((t) => Date.parse(t.eventDate)));
const evalSets: EvalSet[] = payload.sets.map((set) => ({
  p1PlayerId: set.p1PlayerId,
  p2PlayerId: set.p2PlayerId,
  winner: set.winner,
  tournamentId: set.tournamentId,
  time: (Date.parse(payload.tournaments.find((t) => t.id === set.tournamentId)!.eventDate) - origin) / 86_400_000,
}));

const isRookieTournament = (tournamentId: string): boolean => rookieById.get(tournamentId) ?? false;
const variants = [
  whrModel(undefined, 'whr (prior 1500, current)'),
  whrModel(undefined, `whr (rookie prior ${rookieDebutPrior})`, { rookieDebutPrior, isRookieTournament }),
];

const eventOrder = [...payload.tournaments].sort((a, b) => Date.parse(a.eventDate) - Date.parse(b.eventDate));
interface Tally {
  name: string;
  losses: number[];
  islanderProbs: number[];
  islanderWins: number;
}
const tallies: Tally[] = variants.map((v) => ({ name: v.name, losses: [], islanderProbs: [], islanderWins: 0 }));
let crossSets = 0;

for (let index = 2; index < eventOrder.length; index++) {
  const trainingIds = new Set(eventOrder.slice(0, index).map((t) => t.id));
  const training = evalSets.filter((s) => trainingIds.has(s.tournamentId));
  const testing = evalSets.filter((s) => s.tournamentId === eventOrder[index]!.id);
  if (testing.length === 0) continue;

  const mainMatches = new Map<string, number>();
  const matches = new Map<string, number>();
  for (const s of training) {
    for (const id of [s.p1PlayerId, s.p2PlayerId]) {
      matches.set(id, (matches.get(id) ?? 0) + 1);
      if (!isRookieTournament(s.tournamentId)) mainMatches.set(id, (mainMatches.get(id) ?? 0) + 1);
    }
  }
  const islander = (id: string): boolean => (matches.get(id) ?? 0) > 0 && (mainMatches.get(id) ?? 0) === 0;
  const bridged = (id: string): boolean => (mainMatches.get(id) ?? 0) > 0;

  const cross = testing.filter(
    (s) =>
      (islander(s.p1PlayerId) && bridged(s.p2PlayerId)) || (islander(s.p2PlayerId) && bridged(s.p1PlayerId)),
  );
  if (cross.length === 0) continue;
  crossSets += cross.length;

  variants.forEach((variant, vi) => {
    const predict = variant.fit(training);
    for (const s of cross) {
      const p1 = Math.min(1 - 1e-9, Math.max(1e-9, predict(s)));
      const outcome = s.winner === 1 ? 1 : 0;
      tallies[vi]!.losses.push(-(outcome * Math.log(p1) + (1 - outcome) * Math.log(1 - p1)));
      const islanderIsP1 = islander(s.p1PlayerId);
      tallies[vi]!.islanderProbs.push(islanderIsP1 ? p1 : 1 - p1);
      if ((islanderIsP1 && s.winner === 1) || (!islanderIsP1 && s.winner === 2)) tallies[vi]!.islanderWins += 1;
    }
  });
}

console.log(`cross-bracket sets (rookie-only player vs main-experienced player): ${crossSets}\n`);
console.log('model                              log loss   mean p(islander wins)   islander actual win rate');
for (const t of tallies) {
  const n = t.losses.length || 1;
  console.log(
    `${t.name.padEnd(35)}${(t.losses.reduce((s, x) => s + x, 0) / n).toFixed(4)}     ` +
      `${((100 * t.islanderProbs.reduce((s, x) => s + x, 0)) / n).toFixed(1)}%` .padEnd(24) +
      `${((100 * t.islanderWins) / n).toFixed(1)}%`,
  );
}

// ---- 2. board diff ----

const engineInput = { sets: payload.sets, tournaments: payload.tournaments };
const before = runWhrModel({ ...engineInput, settings: defaultGlickoSettings });
const after = runWhrModel({
  ...engineInput,
  settings: { ...defaultGlickoSettings, whrRookieDebutPrior: rookieDebutPrior, whrIsolationAnchor: true },
});

const beforeById = new Map(before.leaderboard.map((r) => [r.playerId, r]));
const rows = after.leaderboard
  .map((row) => {
    const old = beforeById.get(row.playerId)!;
    return {
      name: nameOf(row.playerId),
      oldRank: old.rank,
      newRank: row.rank,
      oldRating: old.skillRating,
      newRating: row.skillRating,
      delta: row.skillRating - old.skillRating,
      rookieRatio: row.rookieRatio,
      matches: row.matchCount,
      isolation: row.isolationFactor,
      nowProvisional: row.isProvisional && !old.isProvisional,
    };
  })
  .sort((a, b) => a.delta - b.delta);

const notable = rows.filter((r) => Math.abs(r.delta) >= 25 || Math.abs(r.oldRank - r.newRank) >= 8);
console.log(`\nboard diff (rookie prior ${rookieDebutPrior} + isolation anchor) — ${notable.length} players move ≥25 pts or ≥8 ranks:`);
console.log('player                 rank         rating           Δ      rookie%  isolation');
for (const r of notable) {
  console.log(
    `${r.name.padEnd(22)}${String(r.oldRank).padStart(3)} → ${String(r.newRank).padEnd(5)}` +
      `${r.oldRating.toFixed(0)} → ${r.newRating.toFixed(0)}    ${(r.delta >= 0 ? '+' : '') + r.delta.toFixed(0)}`.padEnd(35) +
      `${(100 * r.rookieRatio).toFixed(0)}%     ${r.isolation.toFixed(2)}${r.nowProvisional ? '   (now provisional)' : ''}`,
  );
}

const watchlist = ['Lesley Lam', 'Hayley Ferris', 'Dillon', 'Tom MacNevin', 'Matthew Jakeman', 'Ashley Lamont', 'Kai Mashimo', 'Djani Derviskadic'];
console.log('\nwatchlist:');
for (const who of watchlist) {
  const r = rows.find((x) => x.name === who);
  if (!r) continue;
  console.log(
    `${r.name.padEnd(22)}${String(r.oldRank).padStart(3)} → ${String(r.newRank).padEnd(5)}` +
      `${r.oldRating.toFixed(0)} → ${r.newRating.toFixed(0)}    ${(r.delta >= 0 ? '+' : '') + r.delta.toFixed(0)}${r.nowProvisional ? '   (now provisional)' : ''}`,
  );
}
