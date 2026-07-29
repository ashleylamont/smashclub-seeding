import { readFileSync } from 'node:fs';
import type { EngineSet, EngineTournament } from '@smashclub/engine';

/**
 * Reads the legacy Python engine's `glicko_match_history.csv` export and
 * reconstructs both:
 *  - the engine *input* (sets + tournaments, with resolved player ids), and
 *  - the engine *output* it recorded (per-set pre/post rating, RD, volatility).
 *
 * The export is self-contained: it carries stable `player_id`s, the processing
 * order, the tournament of each set, and whether the bracket was a rookie one.
 * Rebuilding the input from it isolates the rating math from identity
 * resolution, which is what the golden master is meant to test.
 */

export interface LegacyRow {
  processingIndex: number;
  tournamentIndex: number;
  date: string;
  tournament: string;
  format: string;
  playerId: string;
  opponentId: string;
  won: boolean;
  preRating: number;
  postRating: number;
  preRd: number;
  postRd: number;
  preVol: number;
  postVol: number;
  isDecaySnapshot: boolean;
  ratingChangeWeight: number;
}

export interface LegacyDataset {
  /** All non-decay rows, in file order. */
  matchRowList: LegacyRow[];
  /** Sets whose both player views were exported. */
  pairs: Array<[LegacyRow, LegacyRow]>;
  /** Rows whose opponent fell outside the exported player list. */
  unpaired: LegacyRow[];
  decayRows: LegacyRow[];
  playerIds: Set<string>;
  /** Tournament names in order of first appearance, with date and bracket type. */
  tournamentOrder: EngineTournament[];
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  const header = splitCsvLine(lines[0]!);
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row: Record<string, string> = {};
    header.forEach((key, index) => {
      row[key] = cells[index] ?? '';
    });
    return row;
  });
}

/** Minimal RFC4180-ish splitter — player names can contain commas in quotes. */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      cells.push(current);
      current = '';
    } else if (char !== '\r') {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

export function loadLegacyHistory(csvPath: string): LegacyDataset {
  const rows: LegacyRow[] = parseCsv(readFileSync(csvPath, 'utf8')).map((raw) => ({
    processingIndex: Number(raw.processing_index),
    tournamentIndex: Number(raw.tournament_index),
    date: raw.date!,
    tournament: raw.tournament!,
    format: raw.format!,
    playerId: raw.player_id!,
    opponentId: raw.opponent_id!,
    won: raw.won === '1' || raw.won?.toLowerCase() === 'true',
    preRating: Number(raw.pre_rating),
    postRating: Number(raw.post_rating),
    preRd: Number(raw.pre_rd),
    postRd: Number(raw.post_rd),
    preVol: Number(raw.pre_volatility),
    postVol: Number(raw.post_volatility),
    isDecaySnapshot: raw.is_decay_snapshot === '1' || raw.is_decay_snapshot?.toLowerCase() === 'true',
    ratingChangeWeight: Number(raw.rating_change_weight),
  }));

  const matchRowList = rows.filter((row) => !row.isDecaySnapshot);
  const decayRows = rows.filter((row) => row.isDecaySnapshot);

  // Both views of a set share a processing index. The export is filtered to the
  // players of the run that produced it, so sets against an outside opponent
  // appear once, with a blank opponent_id.
  const byProcessingIndex = new Map<number, LegacyRow[]>();
  for (const row of matchRowList) {
    const list = byProcessingIndex.get(row.processingIndex) ?? [];
    list.push(row);
    byProcessingIndex.set(row.processingIndex, list);
  }

  const pairs: Array<[LegacyRow, LegacyRow]> = [];
  const unpaired: LegacyRow[] = [];
  for (const [processingIndex, group] of [...byProcessingIndex.entries()].sort((a, b) => a[0] - b[0])) {
    if (group.length === 2) {
      const [a, b] = group as [LegacyRow, LegacyRow];
      if (a.playerId !== b.opponentId || b.playerId !== a.opponentId || a.won === b.won) {
        throw new Error(`Processing index ${processingIndex} is not a consistent pair`);
      }
      pairs.push([a, b]);
    } else if (group.length === 1) {
      unpaired.push(group[0]!);
    } else {
      throw new Error(`Processing index ${processingIndex} has ${group.length} rows`);
    }
  }

  const tournamentOrder: EngineTournament[] = [];
  const seenTournaments = new Set<string>();
  const playerIds = new Set<string>();
  for (const row of matchRowList) {
    playerIds.add(row.playerId);
    if (!seenTournaments.has(row.tournament)) {
      seenTournaments.add(row.tournament);
      tournamentOrder.push({
        id: row.tournament,
        eventDate: row.date,
        isRookie: row.format === '1v1 Rookies',
        challongeId: null,
      });
    }
  }

  return { matchRowList, pairs, unpaired, decayRows, playerIds, tournamentOrder };
}

/** Sets rebuilt from fully-recorded pairs, in recorded processing order. */
export function setsFromPairs(pairs: Array<[LegacyRow, LegacyRow]>): EngineSet[] {
  return pairs.map(([a, b]) => ({
    id: `s${a.processingIndex}`,
    tournamentId: a.tournament,
    p1PlayerId: a.playerId,
    p2PlayerId: b.playerId,
    winner: a.won ? (1 as const) : (2 as const),
    suggestedPlayOrder: a.processingIndex,
    completedAt: null,
    challongeMatchId: a.processingIndex,
  }));
}
