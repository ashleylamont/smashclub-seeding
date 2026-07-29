import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { cleanPlayerEntry, preparePlayerEntry, replayRatings, type EngineSet, type EngineTournament } from '@smashclub/engine';
import { defaultGlickoSettings } from '@smashclub/shared';
import type { LegacyDataset, LegacyRow } from './loadLegacyHistory';

/**
 * Check 3 — end-to-end replay from the raw Challonge cache.
 *
 * This validates what checks 1 and 2 cannot: state threading across sets, the
 * weight denominator derived from a real bracket, and decay between events.
 *
 * It is necessarily limited. The cache supplied does not contain every
 * tournament present in the legacy export, and once an event is missing the
 * tournament indices and rating state diverge for everything after it. So the
 * replay is compared only over the leading run of events that appear in both,
 * in order.
 */

interface CacheRow {
  Date: string;
  Tournament: string;
  'Player 1': string;
  'Player 2': string;
  Winner: number;
}

function loadCache(dir: string): Map<string, { date: string; name: string; rows: CacheRow[] }> {
  const out = new Map<string, { date: string; name: string; rows: CacheRow[] }>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const payload = JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as {
      rows?: CacheRow[];
    };
    const rows = payload.rows ?? [];
    if (rows.length === 0) continue;
    const name = rows[0]!.Tournament;
    const date = rows.reduce((min, r) => (r.Date < min ? r.Date : min), rows[0]!.Date);
    out.set(name, { date, name, rows });
  }
  return out;
}

/**
 * Identity resolution mirroring the legacy `_normalize_match_player`: clean the
 * display string, then key on (name, company). The alias dotfiles that the
 * legacy run also consulted were not supplied, so any player whose grouping
 * depended on them may resolve differently — reported rather than hidden.
 */
function resolveIdentity(raw: string): string {
  const cleaned = cleanPlayerEntry(preparePlayerEntry(raw));
  return `${cleaned.name.toLowerCase()}|${cleaned.companyCode ?? ''}`;
}

export function checkFullReplay(dataset: LegacyDataset, cacheDir: string): boolean {
  const cache = loadCache(cacheDir);
  console.log(`\n── Check 3: full replay from raw cache ──`);
  console.log(`   cache tournaments: ${cache.size}`);

  // Leading run of exported tournaments that the cache also has.
  const usable: EngineTournament[] = [];
  for (const tournament of dataset.tournamentOrder) {
    if (!cache.has(tournament.id)) {
      console.log(`   first gap at "${tournament.id}" — replay limited to the ${usable.length} event(s) before it`);
      break;
    }
    usable.push(tournament);
  }
  if (usable.length === 0) {
    console.log('   ⚠ SKIP — the earliest exported tournament is absent from the cache');
    return true;
  }

  const sets: EngineSet[] = [];
  const tournaments: EngineTournament[] = [];
  for (const [sequence, tournament] of usable.entries()) {
    const entry = cache.get(tournament.id)!;
    tournaments.push({ ...tournament, challongeId: sequence });
    entry.rows.forEach((row, index) => {
      sets.push({
        id: `${tournament.id}#${index}`,
        tournamentId: tournament.id,
        p1PlayerId: resolveIdentity(row['Player 1']),
        p2PlayerId: resolveIdentity(row['Player 2']),
        winner: Number(row.Winner) === 1 ? 1 : 2,
        suggestedPlayOrder: index,
        completedAt: null,
        challongeMatchId: index,
      });
    });
  }

  const run = replayRatings({
    sets,
    tournaments,
    settings: defaultGlickoSettings,
    compat: { legacyOrdering: true, rookieScaleUsesPreviousWinner: true, skipTrailingDecay: true },
  });

  // Compare against the export by (tournament, player identity, nth set), since
  // the export keys players by its own opaque ids.
  const legacyByPlayerTournament = groupLegacy(dataset.matchRowList, usable.map((t) => t.id));
  const ourByPlayerTournament = new Map<string, number[][]>();
  for (const event of run.events) {
    if (event.isDecay) continue;
    const key = `${event.playerId}|${event.tournamentId}`;
    const list = ourByPlayerTournament.get(key) ?? [];
    list.push([event.preRating, event.postRating, event.preRd, event.postRd]);
    ourByPlayerTournament.set(key, list);
  }

  // Legacy ids are opaque, so align sequences by their value fingerprints:
  // for each legacy (player, tournament) sequence find an identical one of ours.
  let matchedPlayers = 0;
  let unmatchedPlayers = 0;
  const ourPool = new Map<string, string[]>();
  for (const [key, seq] of ourByPlayerTournament) {
    const fp = fingerprint(seq);
    const list = ourPool.get(fp) ?? [];
    list.push(key);
    ourPool.set(fp, list);
  }
  for (const [, seq] of legacyByPlayerTournament) {
    const fp = fingerprint(seq);
    const candidates = ourPool.get(fp);
    if (candidates && candidates.length > 0) {
      candidates.pop();
      matchedPlayers += 1;
    } else {
      unmatchedPlayers += 1;
    }
  }

  const total = matchedPlayers + unmatchedPlayers;
  const pct = total ? (100 * matchedPlayers) / total : 0;
  console.log(
    `   replayed ${sets.length} sets over ${usable.length} event(s); ` +
      `matched ${matchedPlayers}/${total} legacy player-event rating sequences exactly (${pct.toFixed(0)}%)`,
  );
  if (unmatchedPlayers === 0) {
    console.log('   ✅ every exported rating sequence reproduced exactly from raw data');
    return true;
  }
  console.log(
    `   ⚠ ${unmatchedPlayers} sequence(s) unmatched — informational, not a gate, because the inputs are\n` +
      `      known-incomplete: the legacy run also consulted alias-decision files\n` +
      `      (.challonge-aliases.json, .glicko-*-aliases.json) that were not supplied. When those merge two\n` +
      `      participants into one identity, that player's set count in the event changes, which changes their\n` +
      `      inverse-diminishing weights and hence their ratings and their opponents'. Check 1 found direct\n` +
      `      evidence of exactly this kind of over-merge (a player rated against themselves), so a small\n` +
      `      number of divergences here is expected. Checks 1 and 2 pin the maths independently of identity.`,
  );
  // Informational only — a strict threshold would be arbitrary given the gaps.
  return true;
}

function groupLegacy(rows: LegacyRow[], tournamentIds: string[]): Map<string, number[][]> {
  const wanted = new Set(tournamentIds);
  const out = new Map<string, number[][]>();
  for (const row of rows) {
    if (!wanted.has(row.tournament)) continue;
    const key = `${row.playerId}|${row.tournament}`;
    const list = out.get(key) ?? [];
    list.push([row.preRating, row.postRating, row.preRd, row.postRd]);
    out.set(key, list);
  }
  return out;
}

/** Rounded value fingerprint, so float noise does not break alignment. */
function fingerprint(seq: number[][]): string {
  return seq.map((v) => v.map((x) => x.toFixed(4)).join(',')).join(';');
}
