import type { Db } from '@smashclub/db';
import { resolvePlayerInputs, type ResolutionPreview } from '../identity/resolver';

/**
 * Turning a pasted attendance list into rows a human can correct.
 *
 * Parsing is a *preview*: nothing here creates a player, an alias, a review
 * item or a tournament participant. An admin pastes the sign-up thread, reads
 * what the club thinks it says, and only then commits.
 */

/** Ceiling on a pasted roster. The club's biggest night is ~40 lines. */
export const ROSTER_MAX_BYTES = 100_000;
export const ROSTER_MAX_LINES = 500;

export interface RosterLine {
  /** 1-based line number in the pasted text, for "row 12 is wrong". */
  lineNumber: number;
  /** The pasted line, surrounding whitespace aside. Kept for the audit trail. */
  rawInput: string;
  /** The same line with copy-paste decoration removed; what gets resolved. */
  input: string;
}

/**
 * One entrant per non-empty line, minus the decoration a copied list drags
 * along: leading bullets, ordered-list numbers, surrounding whitespace.
 *
 * Deliberately does NOT split on commas or any other in-line separator. Club
 * display names routinely contain punctuation — "[Atlas] Fox, back from
 * injury", "Sam (Ana, not Anna)" — and one entrant per line is what every
 * sign-up thread and spreadsheet column already produces, so splitting would
 * only ever manufacture entrants that are not people.
 */
export function parseRosterText(text: string): RosterLine[] {
  const lines: RosterLine[] = [];
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const rawInput = rawLine.trim();
    // A rule between sections of a pasted thread is decoration, not a person.
    if (rawInput === '' || /^[-*•‣·–—_=]+$/.test(rawInput)) continue;
    const input = stripListDecoration(rawInput);
    if (input === '') continue;
    lines.push({ lineNumber: index + 1, rawInput, input });
    if (lines.length >= ROSTER_MAX_LINES) break;
  }
  return lines;
}

/**
 * `- Fox`, `1. Fox`, `12) Fox`, `• Fox` -> `Fox`.
 *
 * The number forms require the punctuation: a bare leading number is already
 * handled by `cleanPlayerEntry` (it is the legacy sign-up-sheet shape), and
 * eating digits without punctuation here would mangle a name that legitimately
 * starts with one.
 */
function stripListDecoration(line: string): string {
  return line
    .replace(/^[-*•‣·–—]+\s+/, '')
    .replace(/^\(?\d+[.)]\s+/, '')
    .trim();
}

export interface RosterResolution extends ResolutionPreview {
  /** Stable id for the row in the browser, before anything is persisted. */
  clientRowId: string;
  lineNumber: number;
  /** Current leaderboard rank, or null for anyone the board does not carry. */
  currentRank: number | null;
  /** Conservative rating — what bracket seeding orders on. */
  seedingScore: number | null;
}

/**
 * Resolve a pasted roster and decorate each row with where its player stands.
 * Reads only; the caller decides what to persist.
 */
export async function resolveRoster(
  db: Db,
  lines: readonly RosterLine[],
  ranking: ReadonlyMap<string, { rank: number; conservativeRating: number }>,
): Promise<RosterResolution[]> {
  const resolutions = await resolvePlayerInputs(
    db,
    lines.map((line) => line.input),
    { scoreResolvedCandidates: true },
  );
  return lines.map((line, index) => {
    const resolution = resolutions[index]!;
    const rating = resolution.playerId ? ranking.get(resolution.playerId) : undefined;
    return {
      ...resolution,
      // The pasted line, not the decoration-stripped one: the row has to show
      // the admin what they actually pasted.
      rawInput: line.rawInput,
      clientRowId: `line-${line.lineNumber}`,
      lineNumber: line.lineNumber,
      currentRank: rating?.rank ?? null,
      seedingScore: rating?.conservativeRating ?? null,
    };
  });
}
