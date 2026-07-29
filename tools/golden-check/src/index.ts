/**
 * Golden-master check against the legacy Python engine's real recorded output.
 *
 * Usage:
 *   pnpm golden-check <glicko_match_history.csv> [<.challonge-cache dir>]
 *
 * The export is *filtered* to the 98 players of the run that produced it: 539
 * sets have both player views recorded, while 254 rows have a blank
 * `opponent_id` because the opponent fell outside that list. A full replay
 * therefore cannot be reconstructed from the CSV alone, so this runs three
 * independent checks that together pin the maths that must be preserved.
 *
 * Note the CSV rounds `rating_change_weight` to 3 decimals, so check 1 solves
 * for the weight from the recorded rating movement rather than trusting the
 * rounded value — otherwise rounding alone produces ~5e-3 rating differences.
 */
import { parseArgs } from 'node:util';
import { updateRating } from '@smashclub/engine';
import { defaultGlickoSettings } from '@smashclub/shared';
import { loadLegacyHistory, type LegacyRow } from './loadLegacyHistory';
import { checkFullReplay } from './fullReplay';

const settings = defaultGlickoSettings;
/** Rating/RD agreement tolerance; the CSV stores 6 decimals. */
const VALUE_TOL = 5e-5;
/** Weight agreement tolerance, bounded by the CSV's 3-decimal rounding. */
const WEIGHT_TOL = 1e-3;

const ROOKIE_SCALES = [0.25, 0.375, 0.4, 0.5, 0.75, 1.0, 1.25];

/**
 * The rookie scale tier a pre-set rating falls into. Below the partial
 * threshold both outcomes scale by the same base value, so the recorded weight
 * reveals nothing about the winner flag — those rows return null.
 */
function tierFor(preRating: number): { win: number; loss: number } | null {
  if (preRating >= settings.rookieOverPenaltyThreshold) return { win: 0.4, loss: 1.25 };
  if (preRating >= settings.rookieFullPenaltyThreshold) return { win: 0.25, loss: 1.0 };
  if (preRating >= settings.rookiePartialPenaltyThreshold) return { win: 0.375, loss: 0.75 };
  return null;
}

function checkPerSetUpdates(allPairs: Array<[LegacyRow, LegacyRow]>): boolean {
  // Legacy identity resolution over-merged at least one pair of players,
  // producing a set where somebody faced themselves; the legacy engine rated it
  // and handed that player a free RD reduction. The new pipeline filters
  // self-play in recompute.ts, so these are excluded here and reported.
  const selfPlay = allPairs.filter(([a, b]) => a.playerId === b.playerId);
  const pairs = allPairs.filter(([a, b]) => a.playerId !== b.playerId);

  let compared = 0;
  let maxRdDelta = 0;
  let maxVolDelta = 0;
  let maxWeightDelta = 0;
  const failures: string[] = [];

  for (const [a, b] of pairs) {
    for (const [self, opp] of [
      [a, b],
      [b, a],
    ] as Array<[LegacyRow, LegacyRow]>) {
      compared += 1;
      const pre = { rating: self.preRating, rd: self.preRd, vol: self.preVol };
      const updated = updateRating(
        pre,
        [{ rating: opp.preRating, rd: opp.preRd, outcome: self.won ? 1 : 0 }],
        settings.tau,
      );

      // Solve the applied weight from the rating movement, immune to the CSV's
      // rounding of the recorded weight.
      const ratingSpan = updated.rating - pre.rating;
      if (Math.abs(ratingSpan) < 1e-9) continue;
      const w = (self.postRating - pre.rating) / ratingSpan;

      // The same scalar must explain the RD movement — this is what actually
      // validates the Glicko-2 update, since a wrong `updated` breaks it.
      const rdPredicted = pre.rd + (updated.rd - pre.rd) * w;
      const rdDelta = Math.abs(rdPredicted - self.postRd);
      maxRdDelta = Math.max(maxRdDelta, rdDelta);

      // Volatility is recorded unlerped, straight from the Glicko-2 update.
      const volDelta = Math.abs(updated.vol - self.postVol);
      maxVolDelta = Math.max(maxVolDelta, volDelta);

      const weightDelta = Math.abs(w - self.ratingChangeWeight);
      maxWeightDelta = Math.max(maxWeightDelta, weightDelta);

      const label = `pi=${self.processingIndex} ${self.playerId.slice(0, 10)}`;
      if (rdDelta > VALUE_TOL) {
        failures.push(`${label} post_rd: recorded ${self.postRd.toFixed(6)}, implied ${rdPredicted.toFixed(6)}`);
      }
      if (volDelta > 1e-6) {
        failures.push(`${label} post_volatility: recorded ${self.postVol.toFixed(6)}, computed ${updated.vol.toFixed(6)}`);
      }
      if (weightDelta > WEIGHT_TOL) {
        failures.push(`${label} weight: recorded ${self.ratingChangeWeight.toFixed(3)}, implied ${w.toFixed(6)}`);
      }
    }
  }

  console.log(`\n── Check 1: per-set Glicko-2 update (${pairs.length} sets, both sides) ──`);
  if (selfPlay.length > 0) {
    console.log(
      `   ⚠ excluded ${selfPlay.length} self-play set(s) — legacy identity resolution merged two players,` +
        ` so somebody was rated against themselves (pi=${selfPlay.map(([a]) => a.processingIndex).join(', ')})`,
    );
  }
  console.log(
    `   ${compared} player-sets   max |Δ| RD ${maxRdDelta.toExponential(2)}, ` +
      `volatility ${maxVolDelta.toExponential(2)}, weight ${maxWeightDelta.toExponential(2)}`,
  );
  if (failures.length === 0) {
    console.log('   ✅ PASS — Glicko-2 update, corrected volatility function, and weight lerp all reproduce exactly');
    return true;
  }
  console.log(`   ❌ FAIL — ${failures.length} mismatches. First 10:`);
  failures.slice(0, 10).forEach((f) => console.log(`      ${f}`));
  return false;
}

/**
 * Check 2 — the weight is `(matchNum / totalInTournament) ^ exponent`, times a
 * rookie-bracket scale in rookie events. Restricted to tournaments with no
 * filtered rows, where per-player set counts are complete.
 *
 * The implied rookie scale also tells us whose outcome the legacy engine used:
 * the current set's winner, or (per the use-before-assign defect) the previous
 * set's. Both hypotheses are scored against the real data.
 */
function checkWeightFormula(dataset: ReturnType<typeof loadLegacyHistory>): boolean {
  const filteredTournaments = new Set(dataset.unpaired.map((r) => r.tournament));
  const rows = dataset.matchRowList.filter((r) => !filteredTournaments.has(r.tournament));
  const tournamentIsRookie = new Map(dataset.tournamentOrder.map((t) => [t.id, t.isRookie]));

  const byPlayerTournament = new Map<string, LegacyRow[]>();
  for (const row of rows) {
    const key = `${row.playerId}|${row.tournament}`;
    const list = byPlayerTournament.get(key) ?? [];
    list.push(row);
    byPlayerTournament.set(key, list);
  }

  // Winner flag of the preceding processed set, for the defect hypothesis.
  const orderedPairs = dataset.pairs.slice().sort((a, b) => a[0].processingIndex - b[0].processingIndex);
  const p1WonByIndex = new Map<number, boolean>();
  for (const [a] of orderedPairs) p1WonByIndex.set(a.processingIndex, a.won);
  const indices = [...p1WonByIndex.keys()].sort((a, b) => a - b);
  const previousP1Won = new Map<number, boolean>();
  for (let i = 1; i < indices.length; i++) {
    previousP1Won.set(indices[i]!, p1WonByIndex.get(indices[i - 1]!)!);
  }

  let mainOk = 0;
  let mainBad = 0;
  let rookieRows = 0;
  let matchesCurrentWinner = 0;
  let matchesPreviousWinner = 0;
  let unexplained = 0;
  let ambiguousTier = 0;
  let discriminating = 0;
  const failures: string[] = [];

  for (const [key, list] of byPlayerTournament) {
    const ordered = [...list].sort((x, y) => x.processingIndex - y.processingIndex);
    const total = ordered.length;
    const isRookie = tournamentIsRookie.get(ordered[0]!.tournament) ?? false;

    ordered.forEach((row, index) => {
      const base = ((index + 1) / total) ** settings.inverseDiminishingExponent;
      if (!isRookie) {
        if (Math.abs(base - row.ratingChangeWeight) <= 1e-3) mainOk += 1;
        else {
          mainBad += 1;
          if (failures.length < 10) {
            failures.push(`${key.slice(0, 26)} [${index + 1}/${total}] expected ${base.toFixed(3)}, recorded ${row.ratingChangeWeight.toFixed(3)}`);
          }
        }
        return;
      }

      rookieRows += 1;
      const impliedScale = row.ratingChangeWeight / base;
      const nearest = ROOKIE_SCALES.reduce((best, s) => (Math.abs(s - impliedScale) < Math.abs(best - impliedScale) ? s : best));
      if (Math.abs(nearest - impliedScale) > 8e-3) {
        unexplained += 1;
        if (failures.length < 10) {
          failures.push(`${key.slice(0, 26)} [${index + 1}/${total}] implied rookie scale ${impliedScale.toFixed(3)} matches no tier`);
        }
        return;
      }

      // The tier is fixed by the player's pre-set rating, so the implied scale
      // says unambiguously whether a WIN or a LOSS flag was used — except in the
      // base tier below 1400, where both give 0.5 and nothing can be inferred.
      const tier = tierFor(row.preRating);
      if (tier === null) {
        ambiguousTier += 1;
        return;
      }
      const impliedWonFlag =
        Math.abs(nearest - tier.win) < Math.abs(nearest - tier.loss) ? true : false;
      // Player 1's flag is the winner flag; player 2's is its negation.
      const isPlayer1 = dataset.pairs.some(([a]) => a.processingIndex === row.processingIndex && a.playerId === row.playerId);
      const currentFlag = isPlayer1 ? row.won : !row.won;
      const prev = previousP1Won.get(row.processingIndex);
      const previousFlag = prev === undefined ? undefined : isPlayer1 ? prev : !prev;
      discriminating += 1;
      if (impliedWonFlag === currentFlag) matchesCurrentWinner += 1;
      if (previousFlag !== undefined && impliedWonFlag === previousFlag) matchesPreviousWinner += 1;
    });
  }

  console.log(
    `\n── Check 2: match-weight formula (${byPlayerTournament.size} player-events in ` +
      `${new Set(rows.map((r) => r.tournament)).size} fully-exported tournaments) ──`,
  );
  console.log(`   main-bracket weights matching (matchNum/total)^${settings.inverseDiminishingExponent}: ${mainOk} ok, ${mainBad} bad`);
  console.log(`   rookie rows: ${rookieRows}, implied scale matches a known tier: ${rookieRows - unexplained}`);
  console.log(
    `   of those, ${ambiguousTier} sit in the base tier (<${settings.rookiePartialPenaltyThreshold}) where win and loss ` +
      `both scale by ${settings.rookieBracketBaseScale} and reveal nothing`,
  );
  const pct = (n: number) => (discriminating ? `${((100 * n) / discriminating).toFixed(0)}%` : 'n/a');
  console.log(
    `   discriminating rows: ${discriminating} — scale consistent with CURRENT set's winner ` +
      `${matchesCurrentWinner} (${pct(matchesCurrentWinner)}), with PREVIOUS set's winner ` +
      `${matchesPreviousWinner} (${pct(matchesPreviousWinner)})`,
  );
  if (discriminating > 0 && matchesPreviousWinner > matchesCurrentWinner * 1.5) {
    console.log("   → confirms the use-before-assign defect: rookie scaling read the previous set's winner");
  } else if (discriminating > 0 && matchesCurrentWinner > matchesPreviousWinner * 1.5) {
    console.log('   → the exported run used the CURRENT winner, so their local Python already fixed this');
  } else {
    console.log(
      '   → inconclusive from weights alone: the two hypotheses agree too often here.\n' +
        '     (The defect is proven directly by reading glicko_calculator.py:285 vs :355.)',
    );
  }
  const ok = mainBad === 0 && unexplained === 0;
  if (ok) {
    console.log('   ✅ PASS — weight formula and rookie tiers reproduce the recorded weights');
  } else {
    console.log(`   ❌ FAIL — ${mainBad} main + ${unexplained} rookie unexplained. First 10:`);
    failures.slice(0, 10).forEach((f) => console.log(`      ${f}`));
  }
  return ok;
}

function main(): void {
  const { positionals } = parseArgs({ allowPositionals: true, options: {}, strict: false });
  const args = positionals.filter((a) => a !== '--');
  const [historyPath, cacheDir] = args;
  if (!historyPath) {
    console.error('usage: golden-check <glicko_match_history.csv> [<.challonge-cache dir>]');
    process.exit(1);
  }

  const dataset = loadLegacyHistory(historyPath);
  console.log(
    `legacy export: ${dataset.matchRowList.length} match rows + ${dataset.decayRows.length} decay rows, ` +
      `${dataset.playerIds.size} players, ${dataset.tournamentOrder.length} tournaments\n` +
      `   fully-recorded sets: ${dataset.pairs.length}   ` +
      `filtered rows (opponent outside exported list): ${dataset.unpaired.length}`,
  );

  const results = [checkPerSetUpdates(dataset.pairs), checkWeightFormula(dataset)];
  if (cacheDir) {
    results.push(checkFullReplay(dataset, cacheDir));
  } else {
    console.log('\n── Check 3: full replay — skipped (pass the cache dir as the 2nd argument) ──');
  }

  const passed = results.every(Boolean);
  console.log(`\n${passed ? '✅ all checks passed' : '❌ some checks failed'}`);
  process.exit(passed ? 0 : 1);
}

main();
