import type { trpc } from './trpc';

/** View-model aliases inferred from the tRPC contract. */

export type LeaderboardData = Awaited<ReturnType<typeof trpc.public.leaderboard.query>>;
export type LeaderboardRow = LeaderboardData['rows'][number];

export type PlayerResult = Awaited<ReturnType<typeof trpc.public.player.query>>;
export type PlayerData = Extract<PlayerResult, { player: unknown }>;

/**
 * Shape of a player's rating events. The server maps these rows through a
 * loosely-typed helper, so the inferred type degrades to Record<string,
 * unknown>; this mirrors the actual row shape (see public.player).
 */
export interface PlayerEventView {
  seq: number;
  isDecay: boolean;
  won: boolean | null;
  preRating: number;
  postRating: number;
  preRd: number;
  postRd: number;
  weight: number;
  /**
   * WHR only, null under Glicko: the current fit's hindsight estimate of
   * skill at this night, revised as later results arrive. `pre`/`post` above
   * are the frozen ledger of what the board published at the time.
   */
  revisedRating: number | null;
  revisedSd: number | null;
  tournamentId: string;
  /**
   * The bracket a set was played in. A decay row is charged for a whole club
   * night rather than a bracket, so it names every bracket that ran that
   * evening — `tournamentId` still points at only the first of them.
   */
  tournamentName: string;
  tournamentDate: string | null;
  /** On a decay row: true only when the night had nothing but a rookie bracket. */
  isRookie: boolean;
  opponentPlayerId: string | null;
  opponentName: string | null;
}

export type RatingHistoryData = Awaited<ReturnType<typeof trpc.public.ratingHistory.query>>;

export type TournamentListItem = Awaited<ReturnType<typeof trpc.public.tournaments.query>>[number];
export type TournamentData = NonNullable<Awaited<ReturnType<typeof trpc.public.tournament.query>>>;
export type TournamentSet = TournamentData['sets'][number];
export type TournamentParticipant = TournamentData['participants'][number];

export type RecapData = NonNullable<Awaited<ReturnType<typeof trpc.public.recap.query>>>;
/** One ranked fact, with the copy the server rendered for it. */
export type RecapFactEntry = RecapData['facts'][number];
/** The structured fact itself — a discriminated union keyed on `kind`. */
export type RecapFact = RecapFactEntry['fact'];
export type RecapPlayer = Extract<RecapFact, { kind: 'clean_sweep' }>['player'];

export type SearchPlayerRow = Awaited<ReturnType<typeof trpc.public.searchPlayers.query>>[number];

export type MyClaim = Awaited<ReturnType<typeof trpc.me.claims.query>>[number];

export type AdminJob = Awaited<ReturnType<typeof trpc.admin.jobs.query>>[number];
export type ReviewItem = Awaited<ReturnType<typeof trpc.admin.reviewQueue.query>>[number];
export type AdminPlayer = Awaited<ReturnType<typeof trpc.admin.players.query>>[number];
export type AdminCompany = Awaited<ReturnType<typeof trpc.admin.companies.query>>[number];
export type AdminClaim = Awaited<ReturnType<typeof trpc.admin.claims.query>>[number];
export type RegistryImportPlan = Awaited<ReturnType<typeof trpc.admin.previewRegistryImport.mutate>>;
export type RegistryEntryPlan = RegistryImportPlan['entries'][number];
export type SeedingRunData = NonNullable<Awaited<ReturnType<typeof trpc.admin.seedingRun.query>>>;
export type SeedingEntry = SeedingRunData['entries'][number];
export type SettingsData = Awaited<ReturnType<typeof trpc.admin.settings.query>>;
export type GlickoSettings = SettingsData['glicko'];
export type ModelComparison = Awaited<ReturnType<typeof trpc.admin.compareModels.query>>;
export type ModelComparisonRow = ModelComparison['rows'][number];

/** Shape of review-item candidates (stored as untyped JSON server-side). */
export interface ReviewCandidate {
  playerId: string;
  name: string;
  companyCode: string | null;
  score: number;
  reason: 'fuzzy' | 'structured' | 'name-shape';
  /** The alias that scored, when it was not the player's registry name. */
  matchedAlias?: string | null;
}

/** Shape of a seeding run's push log (stored as untyped JSON server-side). */
export interface SeedingPushLog {
  verified: boolean;
  log: Array<{
    participantId: string;
    challongeParticipantId: number;
    seed: number;
    ok: boolean;
    error?: string;
  }>;
}
