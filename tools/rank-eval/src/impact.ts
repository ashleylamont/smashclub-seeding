/**
 * What do the rating changes actually do to *this* club's rankings?
 *
 * Prediction scores (log loss and friends) answer "is it more accurate", but
 * not "what would the club see". This compares the leaderboards three
 * configurations produce over the same real history:
 *
 *   A. current   — per-set rating periods, ranked on the conservative score
 *                  (the number the club publishes today)
 *   B. shipped   — same replay, ranked on best-estimate skill with uncertainty
 *                  shown separately, leagues on absolute bands
 *   C. whr       — Whole-History Rating
 *
 * Reports distribution shape, how far players move, and the top of the board
 * under each, so the effect is legible before anything is switched over.
 */
import {
  computeLeaderboard,
  computePlayerScore,
  calibrateLeagueBands,
  fitWhr,
  leagueForRating,
  replayRatings,
  seedingOrder,
  type EngineSet,
  type EngineTournament,
  type EvalSet,
  type PlayerScore,
} from '@smashclub/engine';
import { defaultGlickoSettings, type GlickoSettings } from '@smashclub/shared';

interface Row {
  playerId: string;
  rank: number;
  displayed: number;
  league: string;
  sets: number;
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))]!;
}

function describe(label: string, values: number[]): string {
  const sorted = [...values].sort((a, b) => a - b);
  return (
    `${label.padEnd(26)} min ${quantile(sorted, 0).toFixed(0).padStart(5)}   ` +
    `p25 ${quantile(sorted, 0.25).toFixed(0).padStart(5)}   median ${quantile(sorted, 0.5).toFixed(0).padStart(5)}   ` +
    `p75 ${quantile(sorted, 0.75).toFixed(0).padStart(5)}   max ${quantile(sorted, 1).toFixed(0).padStart(5)}`
  );
}

function toEngineInput(sets: readonly EvalSet[]): { sets: EngineSet[]; tournaments: EngineTournament[] } {
  const tournaments = new Map<string, EngineTournament>();
  const engineSets: EngineSet[] = [];
  sets.forEach((set, index) => {
    if (!tournaments.has(set.tournamentId)) {
      tournaments.set(set.tournamentId, {
        id: set.tournamentId,
        // Times are days since an origin; any consistent ISO date works.
        eventDate: new Date(Date.UTC(2024, 0, 1) + set.time * 86_400_000).toISOString(),
        isRookie: /rookie/i.test(set.tournamentId),
        challongeId: null,
      });
    }
    engineSets.push({
      id: `s${index}`,
      tournamentId: set.tournamentId,
      p1PlayerId: set.p1PlayerId,
      p2PlayerId: set.p2PlayerId,
      winner: set.winner,
      suggestedPlayOrder: index,
      completedAt: null,
      challongeMatchId: index,
    });
  });
  return { sets: engineSets, tournaments: [...tournaments.values()] };
}

function glickoRows(
  sets: readonly EvalSet[],
  settings: GlickoSettings,
  mode: 'current' | 'shipped',
): { rows: Row[]; scores: PlayerScore[]; decayEvents: number; periods: number } {
  const input = toEngineInput(sets);
  const replay = replayRatings({
    sets: input.sets,
    tournaments: input.tournaments,
    settings,
    // "current" reproduces what the club runs today, defects included.
    compat:
      mode === 'current'
        ? {
            legacyOrdering: true,
            rookieScaleUsesPreviousWinner: true,
            skipTrailingDecay: true,
            decayPerBracket: true,
          }
        : undefined,
  });
  const scores = [...replay.finalStates.values()].map((state) =>
    computePlayerScore(state, replay.finalStates, settings),
  );
  const decayEvents = replay.events.filter((event) => event.isDecay).length;
  const periods = new Set(replay.decayPeriods.values()).size;

  if (mode === 'current') {
    // Today's published order: conservative score, and quartile leagues.
    const ordered = seedingOrder(scores);
    const all = ordered.map((s) => s.conservativeRating).sort((a, b) => b - a);
    const bands = calibrateLeagueBands(all);
    return {
      rows: ordered.map((score, index) => ({
        playerId: score.playerId,
        rank: index + 1,
        displayed: score.conservativeRating,
        league: leagueForRating(score.conservativeRating, bands),
        sets: score.matchCount,
      })),
      scores,
      decayEvents,
      periods,
    };
  }

  /*
   * Calibrate the bands from this model's own distribution, exactly as the first
   * recompute does. Comparing calibrated bands for one model against the shipped
   * placeholder defaults for another would make the league spread say more about
   * which column got calibrated than about the models.
   */
  const provisional = computeLeaderboard(replay.finalStates, settings);
  const calibrated: GlickoSettings = {
    ...settings,
    leagueBands: calibrateLeagueBands(provisional.map((row) => row.skillRating)),
  };
  const board = computeLeaderboard(replay.finalStates, calibrated);
  return {
    rows: board.map((row) => ({
      playerId: row.playerId,
      rank: row.rank,
      displayed: row.skillRating,
      league: row.league,
      sets: row.matchCount,
    })),
    scores,
    decayEvents,
    periods,
  };
}

function whrRows(sets: readonly EvalSet[], settings: GlickoSettings): Row[] {
  const fit = fitWhr({
    sets: sets.map((set) => ({
      p1PlayerId: set.p1PlayerId,
      p2PlayerId: set.p2PlayerId,
      winner: set.winner,
      time: set.time,
    })),
    config: { driftVariancePerDay: settings.whrDriftVariancePerDay, priorSd: settings.whrPriorSd },
  });
  const setCounts = new Map<string, number>();
  for (const set of sets) {
    setCounts.set(set.p1PlayerId, (setCounts.get(set.p1PlayerId) ?? 0) + 1);
    setCounts.set(set.p2PlayerId, (setCounts.get(set.p2PlayerId) ?? 0) + 1);
  }
  const latestTime = Math.max(...sets.map((s) => s.time));
  const rows = fit
    .playerIds()
    .map((playerId) => {
      const display = fit.display(playerId, latestTime);
      return { playerId, rating: display.rating, sd: display.sd, sets: setCounts.get(playerId) ?? 0 };
    })
    .sort((a, b) => b.rating - a.rating || a.sd - b.sd || a.playerId.localeCompare(b.playerId));
  const bands = calibrateLeagueBands(rows.map((r) => r.rating));
  return rows.map((row, index) => ({
    playerId: row.playerId,
    rank: index + 1,
    displayed: row.rating,
    league: leagueForRating(row.rating, bands),
    sets: row.sets,
  }));
}

function movement(before: Row[], after: Row[]): { deltas: number[]; biggest: Array<{ playerId: string; from: number; to: number }> } {
  const byId = new Map(before.map((row) => [row.playerId, row]));
  const deltas: number[] = [];
  const moves: Array<{ playerId: string; from: number; to: number }> = [];
  for (const row of after) {
    const previous = byId.get(row.playerId);
    if (!previous) continue;
    deltas.push(row.rank - previous.rank);
    moves.push({ playerId: row.playerId, from: previous.rank, to: row.rank });
  }
  moves.sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from));
  return { deltas, biggest: moves.slice(0, 6) };
}

function leagueSpread(rows: Row[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.league, (counts.get(row.league) ?? 0) + 1);
  return [...counts.entries()].map(([name, n]) => `${name.replace(/[^\w -]/g, '').trim()} ${n}`).join(', ');
}

export function impactReport(sets: readonly EvalSet[], anonymise: boolean): void {
  const settings = defaultGlickoSettings;
  const label = (playerId: string): string => {
    if (!anonymise) return playerId.slice(0, 28);
    // Stable short handle so movements can be followed without naming anyone.
    let hash = 0;
    for (const ch of playerId) hash = (hash * 31 + ch.charCodeAt(0)) % 100_000;
    return `player-${String(hash).padStart(5, '0')}`;
  };

  const current = glickoRows(sets, settings, 'current');
  const shipped = glickoRows(sets, settings, 'shipped');
  const whr = whrRows(sets, settings);

  console.log('\n══════════ what the rating changes do to this data ══════════\n');
  console.log(`players ranked: ${current.rows.length}\n`);

  console.log('── the number each player sees ──');
  console.log(describe('A. current (published)', current.rows.map((r) => r.displayed)));
  console.log(describe('B. shipped (skill)', shipped.rows.map((r) => r.displayed)));
  console.log(describe('C. whr', whr.map((r) => r.displayed)));
  const belowStart = (rows: Row[]): number => rows.filter((r) => r.displayed < 1500).length;
  console.log(
    `\n  players shown below the 1500 starting point:  ` +
      `current ${belowStart(current.rows)}/${current.rows.length}   ` +
      `shipped ${belowStart(shipped.rows)}/${shipped.rows.length}   ` +
      `whr ${belowStart(whr)}/${whr.length}`,
  );

  console.log('\n── how much the order moves vs today ──');
  for (const [name, rows] of [
    ['B. shipped (skill ranking)', shipped.rows],
    ['C. whr', whr],
  ] as Array<[string, Row[]]>) {
    const { deltas, biggest } = movement(current.rows, rows);
    const moved = deltas.filter((d) => d !== 0).length;
    const mean = deltas.reduce((s, d) => s + Math.abs(d), 0) / (deltas.length || 1);
    const top10Before = new Set(current.rows.slice(0, 10).map((r) => r.playerId));
    const top10After = new Set(rows.slice(0, 10).map((r) => r.playerId));
    const kept = [...top10After].filter((id) => top10Before.has(id)).length;
    console.log(
      `\n  ${name}: ${moved}/${deltas.length} players change rank, mean |Δrank| ${mean.toFixed(1)}, ` +
        `max ${Math.max(0, ...deltas.map(Math.abs))}`,
    );
    console.log(`     top 10 retained from today's top 10: ${kept}/10`);
    console.log(
      `     biggest moves: ` +
        biggest.map((m) => `${label(m.playerId)} ${m.from}→${m.to}`).join(', '),
    );
  }

  /*
   * Decay used to be counted per bracket. The club runs a main and a rookie
   * bracket on one evening, so a main-only regular was charged a decay step for
   * every rookie bracket they were never in.
   *
   * Isolated deliberately: the "current" column also skips trailing decay, so
   * comparing against it would conflate two separate changes. This toggles only
   * decayPerBracket, holding everything else at the shipped settings.
   */
  const decayAb = (perBracket: boolean): { events: number; medianRd: number; atCap: number; periods: number } => {
    const input = toEngineInput(sets);
    const replay = replayRatings({
      sets: input.sets,
      tournaments: input.tournaments,
      settings,
      compat: perBracket ? { decayPerBracket: true } : undefined,
    });
    /*
     * Effective RD, not raw: the published figure applies the rookie-isolation
     * multiplier on top, and that is the quantity that saturates at the cap.
     * On the club's own export 31 of 98 players sit at the cap on effective RD
     * while none do on raw RD, so measuring the raw value would report a
     * problem that looks absent.
     */
    const rds = [...replay.finalStates.values()]
      .map((state) => computePlayerScore(state, replay.finalStates, settings).effectiveRd)
      .sort((a, b) => a - b);
    return {
      events: replay.events.filter((event) => event.isDecay).length,
      medianRd: rds[Math.floor(rds.length / 2)] ?? NaN,
      atCap: rds.filter((rd) => rd >= settings.rdCap - 0.5).length,
      periods: new Set(replay.decayPeriods.values()).size,
    };
  };
  const perBracket = decayAb(true);
  const perDay = decayAb(false);

  console.log('\n── inactivity decay: counted per bracket vs per event day ──');
  console.log(`  periods:      per-bracket ${perBracket.periods}   per-day ${perDay.periods}`);
  console.log(
    `  decay events: per-bracket ${perBracket.events}   per-day ${perDay.events}   ` +
      `(${perBracket.events - perDay.events} were for brackets the player was never in, ` +
      `${(((perBracket.events - perDay.events) / (perBracket.events || 1)) * 100).toFixed(0)}%)`,
  );
  console.log(
    `  median effective RD: per-bracket ${perBracket.medianRd.toFixed(0)}   per-day ${perDay.medianRd.toFixed(0)}`,
  );
  console.log(
    `  at the RD cap:       per-bracket ${perBracket.atCap}/${current.rows.length}   per-day ${perDay.atCap}/${current.rows.length}`,
  );

  console.log('\n── league spread ──');
  console.log(`  current: ${leagueSpread(current.rows)}`);
  console.log(`  shipped: ${leagueSpread(shipped.rows)}`);
  console.log(`  whr:     ${leagueSpread(whr)}`);

  console.log('\n── top 8 under each ──');
  const width = 30;
  console.log(
    `  ${'A. current (conservative)'.padEnd(width)}${'B. shipped (skill)'.padEnd(width)}C. whr`,
  );
  for (let i = 0; i < 8; i++) {
    const cells = [current.rows[i], shipped.rows[i], whr[i]].map((row) =>
      row ? `${i + 1}. ${label(row.playerId)} ${row.displayed.toFixed(0)}`.padEnd(width) : ''.padEnd(width),
    );
    console.log(`  ${cells.join('')}`);
  }

  console.log('\n── seeding is now a separate question ──');
  const seeds = seedingOrder(shipped.scores);
  const rankById = new Map(shipped.rows.map((row) => [row.playerId, row.rank]));
  const disagreements = seeds
    .map((score, index) => ({
      playerId: score.playerId,
      seed: index + 1,
      rank: rankById.get(score.playerId) ?? 0,
      sets: score.matchCount,
    }))
    .filter((entry) => Math.abs(entry.seed - entry.rank) >= 5)
    .sort((a, b) => Math.abs(b.seed - b.rank) - Math.abs(a.seed - a.rank))
    .slice(0, 6);
  console.log(
    `  players whose seed differs from their rank by 5+ places: ` +
      `${disagreements.length ? disagreements.map((d) => `${label(d.playerId)} rank ${d.rank}/seed ${d.seed} (${d.sets} sets)`).join(', ') : 'none'}`,
  );
  console.log(
    '  (a gap here is intended: the leaderboard states the best estimate, seeding stays cautious about thin evidence)',
  );
}
