import type { eventPlans } from '@smashclub/db';
import type { CompetitionFormat, TournamentStructure } from '@smashclub/shared';
import type { Division, DivisionPreference, PlanIssue } from './divisions';
import type { ConsolationBracket } from './advancement';
import type { ReviewCandidateSnapshot } from '../identity/candidates';

export type PlanStatus =
  'draft' | 'roster_frozen' | 'pools_ready' | 'underway' | 'complete' | 'cancelled';
export type BracketStage = 'main' | 'consolation';

/** The four brackets a two-division club night needs, in handoff order. */
export const BRACKET_SLOTS: readonly { division: Division; stage: BracketStage }[] = [
  { division: 'upper', stage: 'main' },
  { division: 'upper', stage: 'consolation' },
  { division: 'lower', stage: 'main' },
  { division: 'lower', stage: 'consolation' },
];

export class EventPlanStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventPlanStateError';
  }
}

export interface PlanEntryView {
  id: string;
  sourceLineNumber: number;
  rawInput: string;
  cleanedName: string;
  companyCode: string | null;
  playerId: string | null;
  primaryPlayerId?: string | null;
  partnerPlayerId?: string | null;
  teamName?: string | null;
  memberPlayerIds?: string[];
  memberNames?: string[];
  snapshotMean?: number | null;
  snapshotSd?: number | null;
  currentMean?: number;
  currentSd?: number;
  /** Registry name — an admin surface, so shown in full. */
  playerName: string | null;
  withdrawn?: boolean;
  /** What the export and every public surface will call them. */
  publicName: string | null;
  playerStatus: string | null;
  resolutionMethod: string;
  divisionPreference: DivisionPreference;
  assignedDivision: Division | null;
  snapshotRank: number | null;
  snapshotScore: number | null;
  divisionSeed: number | null;
  /** Where they stand on the board *now*, which a frozen plan may disagree with. */
  currentRank: number | null;
  currentScore: number | null;
  lastPlayedDate: string | null;
  /** Ranked suggestions for an unresolved row. Never auto-selected. */
  candidates: ReviewCandidateSnapshot[];
}

export interface PoolView {
  poolIndex: number;
  label: string;
  matchRevisions?: { id: string; revision: number }[];
  placementRevision?: string;
  members: {
    entryId: string;
    playerId: string;
    name: string;
    seed: number;
    snapshotRank: number | null;
    /** Confirmed finish, once the worksheet has been filled in. */
    place: number | null;
    withdrawn?: boolean;
  }[];
}

export interface DivisionView {
  division: Division;
  size: number;
  poolCount: number;
  pools: PoolView[];
  /** Null until every pool in the division has a confirmed 1-4. */
  consolation: ConsolationBracket | null;
  championship: { playerId: string; name: string; label: string }[];
}

export interface PlanView {
  plan: {
    id: string;
    name: string;
    eventDate: string;
    slugPrefix: string | null;
    status: PlanStatus;
    softLockedAt: string | null;
    softLockedBy: string | null;
    bracketMode: 'native' | 'challonge';
    competitionFormat?: CompetitionFormat;
    structure?: TournamentStructure;
    usePairRatings?: boolean;
    nativeSeedContext?: Record<string, unknown> | null;
    historicalAdoption: typeof eventPlans.$inferSelect.historicalAdoption;
    upperTargetSize: number | null;
    poolSize: number;
    rankingSnapshotAt: string | null;
    createdAt: string;
  };
  entries: PlanEntryView[];
  divisions: DivisionView[];
  brackets: {
    id: string;
    division: Division;
    stage: BracketStage;
    challongeSlug: string | null;
    tournamentId: string | null;
    externalState: string;
    lastError: string | null;
    /** The tournament row's event date, so a mismatch is visible not implied. */
    tournamentEventDate: string | null;
    tournamentSyncState: string | null;
    tournamentIsRookie: boolean | null;
    suggestedSlug: string;
  }[];
  issues: { blocking: PlanIssue[]; warnings: PlanIssue[] };
}
