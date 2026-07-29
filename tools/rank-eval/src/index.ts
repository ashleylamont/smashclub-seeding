/**
 * Compares rating models by out-of-sample prediction on real match history.
 *
 * Usage:
 *   pnpm rank-eval <.challonge-cache dir>     # real data
 *   pnpm rank-eval --synthetic                # generated data with known truth
 *
 * Reads the raw Challonge cache directly, so it needs no database and no
 * network — a club admin can run it locally against their own cache.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parse as parseYaml } from 'yaml';
import {
  cleanPlayerEntry,
  coinFlipModel,
  experienceModel,
  legacyGlickoModel,
  pairedBootstrap,
  preparePlayerEntry,
  tournamentGlickoModel,
  unweightedTournamentGlickoModel,
  walkForward,
  whrModel,
  winRateModel,
  type EvalModel,
  type EvalSet,
  type ModelScore,
} from '@smashclub/engine';
import { defaultGlickoSettings } from '@smashclub/shared';

interface CacheRow {
  Date: string;
  Tournament: string;
  'Player 1': string;
  'Player 2': string;
  Winner: number | string;
}

/**
 * Registry-backed identity resolution, mirroring the legacy PlayerRegistry:
 * aliases resolve under the player's company, each past company, and with no
 * company at all. Without this, one person appears as several players.
 */
function buildRegistryResolver(registryPath: string): (cleanedName: string, companyCode: string | null) => string | null {
  const payload = parseYaml(readFileSync(registryPath, 'utf8')) as {
    players?: Array<{
      id: string;
      canonical_name: string;
      company?: string | null;
      aliases?: string[] | null;
      past_companies?: string[] | null;
    }>;
  };
  const map = new Map<string, string>();
  for (const player of payload.players ?? []) {
    const companies = new Set<string>(['', 'n/a', (player.company ?? '').toLowerCase()]);
    for (const past of player.past_companies ?? []) companies.add((past ?? '').toLowerCase());
    for (const name of [player.canonical_name, ...(player.aliases ?? [])]) {
      for (const company of companies) {
        map.set(`${name.trim().toLowerCase()}|${company}`, player.id);
      }
    }
  }
  return (cleanedName, companyCode) => {
    const name = cleanedName.trim().toLowerCase();
    return (
      map.get(`${name}|${(companyCode ?? '').toLowerCase()}`) ??
      map.get(`${name}|`) ??
      map.get(`${name}|n/a`) ??
      null
    );
  };
}

function loadFromCache(cacheDir: string, registryPath?: string): EvalSet[] {
  const sets: EvalSet[] = [];
  const resolve = registryPath ? buildRegistryResolver(registryPath) : null;
  const identity = (raw: string): string => {
    const cleaned = cleanPlayerEntry(preparePlayerEntry(String(raw)));
    const registryId = resolve?.(cleaned.name, cleaned.companyCode);
    if (registryId) return `registry:${registryId}`;
    return `${cleaned.name.toLowerCase()}|${cleaned.companyCode ?? ''}`;
  };
  const origin = Date.UTC(2024, 0, 1);
  for (const file of readdirSync(cacheDir)) {
    if (!file.endsWith('.json')) continue;
    const payload = JSON.parse(readFileSync(path.join(cacheDir, file), 'utf8')) as { rows?: CacheRow[] };
    const rows = payload.rows ?? [];
    if (rows.length < 5) continue; // skip unit-test fixtures living alongside
    for (const row of rows) {
      const p1 = identity(row['Player 1']);
      const p2 = identity(row['Player 2']);
      if (p1 === p2) continue; // legacy over-merge produced self-play
      sets.push({
        p1PlayerId: p1,
        p2PlayerId: p2,
        winner: Number(row.Winner) === 1 ? 1 : 2,
        tournamentId: row.Tournament,
        time: (Date.parse(`${row.Date}T00:00:00Z`) - origin) / 86_400_000,
      });
    }
  }
  return sets;
}

function syntheticSets(): EvalSet[] {
  let state = 4242;
  const random = (): number => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  const playerCount = 60;
  const skill = Array.from({ length: playerCount }, (_, i) => (i - playerCount / 2) / 12);
  const sets: EvalSet[] = [];
  for (let event = 0; event < 12; event++) {
    const rookie = event % 2 === 1;
    const [lo, hi] = rookie ? [30, playerCount] : [0, 36];
    for (let s = 0; s < 60; s++) {
      const a = lo + Math.floor(random() * (hi - lo));
      let b = lo + Math.floor(random() * (hi - lo));
      if (a === b) b = lo + ((a + 1 - lo) % (hi - lo));
      const p = 1 / (1 + Math.exp(-(skill[a]! - skill[b]!)));
      sets.push({
        p1PlayerId: `p${a}`,
        p2PlayerId: `p${b}`,
        winner: random() < p ? 1 : 2,
        tournamentId: `${rookie ? 'rookies' : 'main'}-${event}`,
        time: event * 60,
      });
    }
  }
  return sets;
}

function describeData(sets: EvalSet[]): void {
  const players = new Set<string>();
  const events = new Set<string>();
  const setsPerPlayer = new Map<string, number>();
  for (const set of sets) {
    players.add(set.p1PlayerId);
    players.add(set.p2PlayerId);
    events.add(set.tournamentId);
    for (const id of [set.p1PlayerId, set.p2PlayerId]) {
      setsPerPlayer.set(id, (setsPerPlayer.get(id) ?? 0) + 1);
    }
  }
  const counts = [...setsPerPlayer.values()].sort((a, b) => a - b);
  const median = counts[Math.floor(counts.length / 2)] ?? 0;
  console.log(
    `data: ${sets.length} sets, ${events.size} events, ${players.size} players ` +
      `(median ${median} sets each, ${counts.filter((c) => c <= 2).length} with ≤2)`,
  );
}

function table(scores: ModelScore[]): void {
  const best = Math.min(...scores.map((s) => s.logLoss));
  const width = Math.max(...scores.map((s) => s.name.length));
  console.log(`\n${'model'.padEnd(width)}   log loss   Brier   accuracy   uninformative`);
  console.log('─'.repeat(width + 45));
  for (const score of [...scores].sort((a, b) => a.logLoss - b.logLoss)) {
    const marker = score.logLoss === best ? ' ←' : '';
    console.log(
      `${score.name.padEnd(width)}   ${score.logLoss.toFixed(4)}   ${score.brier.toFixed(4)}   ` +
        `${(100 * score.accuracy).toFixed(1)}%      ${(100 * score.uninformative).toFixed(0)}%${marker}`,
    );
  }
}

function calibrationReport(score: ModelScore): void {
  console.log(`\ncalibration — ${score.name}`);
  console.log('  predicted band    n    mean predicted    actually won');
  for (const bin of score.calibration) {
    if (!bin.count) continue;
    console.log(
      `  ${(100 * bin.lower).toFixed(0)}–${(100 * bin.upper).toFixed(0)}%` .padEnd(18) +
        `${String(bin.count).padStart(4)}    ${(100 * bin.predicted).toFixed(1)}%`.padEnd(18) +
        `    ${(100 * bin.observed).toFixed(1)}%`,
    );
  }
}

function main(): void {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { synthetic: { type: 'boolean' }, calibration: { type: 'boolean' }, registry: { type: 'string' } },
    strict: false,
  });
  const cacheDir = positionals.find((p) => p !== '--');

  const sets = values.synthetic || !cacheDir ? syntheticSets() : loadFromCache(cacheDir, values.registry as string | undefined);
  console.log(
    values.synthetic || !cacheDir
      ? 'source: synthetic (known ground truth)'
      : `source: ${cacheDir}${values.registry ? ` (identities resolved via ${values.registry})` : ' (raw identities, no registry)'}`,
  );
  describeData(sets);

  const settings = defaultGlickoSettings;
  const models: EvalModel[] = [
    coinFlipModel,
    experienceModel,
    winRateModel,
    legacyGlickoModel(settings),
    tournamentGlickoModel(settings),
    unweightedTournamentGlickoModel(settings),
    whrModel(undefined, 'whr'),
    whrModel({ driftVariancePerDay: 0.00005 }, 'whr (slow drift)'),
    whrModel({ driftVariancePerDay: 0.0008 }, 'whr (fast drift)'),
  ];

  const { scores, folds, evaluatedSets } = walkForward({ sets, models, minTrainingEvents: 2 });
  console.log(`\nwalk-forward: ${folds} folds, ${evaluatedSets} out-of-sample sets predicted`);
  table(scores);

  // Paired comparison of the two candidates against what the club runs today.
  const baseline = scores.find((s) => s.name.startsWith('glicko-2 (legacy'));
  if (baseline) {
    console.log('\nvs the current system (negative difference = better), paired bootstrap 95% CI:');
    for (const score of scores) {
      if (score === baseline || score.name.startsWith('baseline:')) continue;
      const result = pairedBootstrap(score.perSetLogLoss, baseline.perSetLogLoss);
      const verdict =
        result.upper < 0 ? 'better' : result.lower > 0 ? 'worse' : 'not distinguishable';
      console.log(
        `  ${score.name.padEnd(38)} Δ ${result.meanDifference >= 0 ? '+' : ''}${result.meanDifference.toFixed(4)}  ` +
          `[${result.lower.toFixed(4)}, ${result.upper.toFixed(4)}]  ${verdict}`,
      );
    }
  }

  if (values.calibration) {
    const bestScore = [...scores].sort((a, b) => a.logLoss - b.logLoss)[0]!;
    calibrationReport(bestScore);
    if (baseline) calibrationReport(baseline);
  }

  if (values['identity-impact'] && cacheDir && values.registry) {
    identityImpact(cacheDir, String(values.registry), models);
  }
}

/**
 * Quantifies identity resolution against model choice by running the identical
 * model set over the same history twice — once with players fragmented across
 * name spellings, once resolved through the registry.
 *
 * This is the comparison that should drive where effort goes.
 */
function identityImpact(cacheDir: string, registryPath: string, models: readonly EvalModel[]): void {
  const raw = walkForward({ sets: loadFromCache(cacheDir), models, minTrainingEvents: 2 });
  const resolved = walkForward({ sets: loadFromCache(cacheDir, registryPath), models, minTrainingEvents: 2 });

  const bestOf = (scores: ModelScore[]): ModelScore =>
    [...scores].filter((s) => !s.name.startsWith('baseline:')).sort((a, b) => a.logLoss - b.logLoss)[0]!;
  const rawBest = bestOf(raw.scores);
  const resolvedBest = bestOf(resolved.scores);

  const identityGain = rawBest.logLoss - resolvedBest.logLoss;
  const rawLegacy = raw.scores.find((s) => s.name.startsWith('glicko-2 (legacy'))!;
  const resolvedLegacy = resolved.scores.find((s) => s.name.startsWith('glicko-2 (legacy'))!;
  const modelGain = resolvedLegacy.logLoss - resolvedBest.logLoss;

  console.log('\n════ where does the improvement actually come from? ════');
  console.log(
    `  fragmented identities: best model ${rawBest.logLoss.toFixed(4)} log loss, ` +
      `${(100 * rawBest.accuracy).toFixed(1)}% accuracy, ${(100 * rawBest.uninformative).toFixed(0)}% coin-flip predictions`,
  );
  console.log(
    `  resolved identities:   best model ${resolvedBest.logLoss.toFixed(4)} log loss, ` +
      `${(100 * resolvedBest.accuracy).toFixed(1)}% accuracy, ${(100 * resolvedBest.uninformative).toFixed(0)}% coin-flip predictions`,
  );
  console.log(`\n  gain from resolving identities: ${identityGain.toFixed(4)} log loss`);
  console.log(`  gain from the best model swap:  ${modelGain.toFixed(4)} log loss`);
  if (modelGain > 0) {
    console.log(
      `  → identity resolution is worth ${(identityGain / modelGain).toFixed(1)}× the algorithm change. ` +
        `Invest in the review queue.`,
    );
  }
  console.log(`  (fragmentation also left ${rawLegacy.predictions - resolvedLegacy.predictions} fewer usable comparisons)`);
}

main();
