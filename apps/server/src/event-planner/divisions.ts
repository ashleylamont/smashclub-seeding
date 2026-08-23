/**
 * Splitting an attendance list into Upper and Lower, and saying — before
 * anything is written — every reason it cannot be split yet.
 *
 * Pure: the caller supplies the frozen ranking snapshot and the pins, this
 * decides the divisions and the seed order within them. Divisions are a
 * competitive split on current club ranking; they are emphatically NOT the
 * rookie flag, which means something else entirely (see `tournaments.isRookie`)
 * and must not be set for Lower.
 */

export type Division = 'upper' | 'lower';
export type DivisionPreference = 'auto' | Division;

export interface DivisionCandidate {
  entryId: string;
  playerId: string;
  divisionPreference: DivisionPreference;
  /** Frozen leaderboard rank; null for anyone the board does not carry yet. */
  snapshotRank: number | null;
  /** Paste order, the tiebreak among equally unranked entrants. */
  sourceLineNumber: number;
}

export interface DivisionPlacement {
  entryId: string;
  playerId: string;
  division: Division;
  /** 1-based seed within the division. */
  seed: number;
  snapshotRank: number | null;
  /** True when an admin pinned this entrant rather than the rank deciding. */
  pinned: boolean;
}

export interface PlanIssue {
  code: string;
  message: string;
  /** Rows the issue is about, so the UI can link straight to them. */
  entryIds?: string[];
}

export class EventPlanValidationError extends Error {
  constructor(readonly issues: PlanIssue[]) {
    super(issues.map((issue) => issue.message).join(' '));
    this.name = 'EventPlanValidationError';
  }
}

/**
 * The Upper size to offer by default: half the field, but only when that leaves
 * both divisions a whole number of pools. Otherwise there is a real choice to
 * make — 20 attendees can be 8/12 or 12/8 — and the app should not make it
 * quietly.
 */
export function defaultUpperSize(total: number, poolSize = 4): number | null {
  if (total < poolSize * 2 || total % poolSize !== 0) return null;
  const half = total / 2;
  if (half % poolSize !== 0) return null;
  return half;
}

/** Every Upper size that leaves both divisions a whole number of pools. */
export function validUpperSizes(total: number, poolSize = 4): number[] {
  if (total < poolSize * 2 || total % poolSize !== 0) return [];
  const sizes: number[] = [];
  for (let size = poolSize; size <= total - poolSize; size += poolSize) sizes.push(size);
  return sizes;
}

/**
 * Everything that must be true before a roster can be frozen. Returned as a
 * list rather than thrown one at a time so an admin fixes the whole roster in
 * one pass instead of playing whack-a-mole with the first error.
 */
export function validateDivisionInput(
  candidates: readonly DivisionCandidate[],
  options: { upperTargetSize: number | null; poolSize: number },
): PlanIssue[] {
  const { upperTargetSize, poolSize } = options;
  const issues: PlanIssue[] = [];
  const total = candidates.length;

  const duplicates = new Map<string, string[]>();
  for (const candidate of candidates) {
    duplicates.set(candidate.playerId, [...(duplicates.get(candidate.playerId) ?? []), candidate.entryId]);
  }
  for (const [, entryIds] of duplicates) {
    if (entryIds.length > 1) {
      issues.push({
        code: 'duplicate_player',
        message: 'The same player appears on more than one row.',
        entryIds,
      });
    }
  }

  const unrankedAuto = candidates.filter(
    (candidate) => candidate.snapshotRank === null && candidate.divisionPreference === 'auto',
  );
  if (unrankedAuto.length > 0) {
    issues.push({
      code: 'unranked_needs_division',
      message:
        `${unrankedAuto.length} entrant(s) have no club ranking, so nothing can place them automatically. ` +
        'Pick Upper or Lower for each.',
      entryIds: unrankedAuto.map((candidate) => candidate.entryId),
    });
  }

  if (total < poolSize * 2) {
    issues.push({
      code: 'too_few_entrants',
      message: `Two divisions of ${poolSize} need at least ${poolSize * 2} entrants; this roster has ${total}.`,
    });
    return issues;
  }
  if (total % poolSize !== 0) {
    issues.push({
      code: 'total_not_divisible',
      message: `${total} entrants do not divide into pools of ${poolSize}. Add or remove ${total % poolSize} row(s).`,
    });
  }

  if (upperTargetSize === null) {
    issues.push({
      code: 'upper_size_unset',
      message: 'Choose how many players go in the Upper division.',
    });
    return issues;
  }
  if (upperTargetSize % poolSize !== 0 || (total - upperTargetSize) % poolSize !== 0) {
    issues.push({
      code: 'division_not_divisible',
      message:
        `An Upper division of ${upperTargetSize} leaves ${total - upperTargetSize} in Lower; ` +
        `both must be whole multiples of ${poolSize}.`,
    });
  }
  if (upperTargetSize < poolSize || total - upperTargetSize < poolSize) {
    issues.push({
      code: 'division_too_small',
      message: `Each division needs at least ${poolSize} players.`,
    });
  }

  const pinnedUpper = candidates.filter((candidate) => candidate.divisionPreference === 'upper');
  const pinnedLower = candidates.filter((candidate) => candidate.divisionPreference === 'lower');
  if (pinnedUpper.length > upperTargetSize) {
    issues.push({
      code: 'pins_exceed_upper',
      message: `${pinnedUpper.length} entrants are pinned to Upper, which only has ${upperTargetSize} places.`,
      entryIds: pinnedUpper.map((candidate) => candidate.entryId),
    });
  }
  if (pinnedLower.length > total - upperTargetSize) {
    issues.push({
      code: 'pins_exceed_lower',
      message: `${pinnedLower.length} entrants are pinned to Lower, which only has ${total - upperTargetSize} places.`,
      entryIds: pinnedLower.map((candidate) => candidate.entryId),
    });
  }

  return issues;
}

/**
 * Place every entrant, then seed within each division.
 *
 *  1. honour every explicit pin;
 *  2. sort the rest by frozen leaderboard rank;
 *  3. fill the remaining Upper places from the top of that list;
 *  4. the remainder is Lower.
 *
 * Within a division the order is the same ranking order, with unranked players
 * last — a newcomer seeds at the bottom of whichever division an admin put them
 * in, which is where being wrong about them costs the draw least. An admin can
 * still drag them anywhere afterwards.
 *
 * Throws `EventPlanValidationError` rather than guessing: every condition it
 * rejects is one where a guess would silently produce a different night than
 * the organiser intended.
 */
export function assignDivisions(
  candidates: readonly DivisionCandidate[],
  options: { upperTargetSize: number | null; poolSize: number },
): DivisionPlacement[] {
  const issues = validateDivisionInput(candidates, options);
  if (issues.length > 0) throw new EventPlanValidationError(issues);

  const upperTargetSize = options.upperTargetSize!;
  const upper: DivisionCandidate[] = [];
  const lower: DivisionCandidate[] = [];
  const auto: DivisionCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.divisionPreference === 'upper') upper.push(candidate);
    else if (candidate.divisionPreference === 'lower') lower.push(candidate);
    else auto.push(candidate);
  }

  // Every auto entrant is ranked at this point — `validateDivisionInput`
  // rejects the alternative — so ranking order is total.
  const byRank = [...auto].sort(seedOrder);
  const upperPlaces = upperTargetSize - upper.length;
  upper.push(...byRank.slice(0, upperPlaces));
  lower.push(...byRank.slice(upperPlaces));

  return [
    ...seedDivision(upper, 'upper'),
    ...seedDivision(lower, 'lower'),
  ];
}

function seedDivision(members: readonly DivisionCandidate[], division: Division): DivisionPlacement[] {
  return [...members].sort(seedOrder).map((candidate, index) => ({
    entryId: candidate.entryId,
    playerId: candidate.playerId,
    division,
    seed: index + 1,
    snapshotRank: candidate.snapshotRank,
    pinned: candidate.divisionPreference !== 'auto',
  }));
}

/** Ranked first, best rank first; unranked after them in paste order. */
function seedOrder(a: DivisionCandidate, b: DivisionCandidate): number {
  if (a.snapshotRank !== null && b.snapshotRank !== null) {
    return a.snapshotRank - b.snapshotRank || a.sourceLineNumber - b.sourceLineNumber;
  }
  if (a.snapshotRank !== null) return -1;
  if (b.snapshotRank !== null) return 1;
  return a.sourceLineNumber - b.sourceLineNumber;
}
