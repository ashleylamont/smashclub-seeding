/**
 * Engine input/output types. The engine is pure: it receives fully-resolved
 * sets (both players linked to real player IDs) and tournament metadata, and
 * returns rating events plus final per-player state. No I/O, no clock.
 */

export interface EngineTournament {
  id: string;
  /**
   * Chronological anchor (ISO 8601 date or datetime). Together with the
   * tie-breakers below this determines rating order — it is a rating input.
   */
  eventDate: string;
  /** Rookie brackets get down-weighted rating changes. */
  isRookie: boolean;
  /** Used as a deterministic tie-breaker for tournaments on the same date. */
  challongeId?: number | null;
}

export interface EngineSet {
  id: string;
  tournamentId: string;
  p1PlayerId: string;
  p2PlayerId: string;
  winner: 1 | 2;
  /** Challonge's bracket ordering hint; primary in-tournament order key. */
  suggestedPlayOrder?: number | null;
  /** Completion time (ISO 8601), secondary in-tournament order key. */
  completedAt?: string | null;
  /** Stable final tie-breaker. */
  challongeMatchId?: number | null;
}

export interface RatingEvent {
  /** Global deterministic processing order across all events. */
  seq: number;
  playerId: string;
  /** Null for inactivity-decay events. */
  setId: string | null;
  tournamentId: string;
  isDecay: boolean;
  /** Null for decay events. */
  won: boolean | null;
  opponentId: string | null;
  preRating: number;
  postRating: number;
  preRd: number;
  postRd: number;
  preVol: number;
  postVol: number;
  /** Effective rating-change weight applied to this set (1 for decay events). */
  weight: number;
}

export interface PlayerFinalState {
  playerId: string;
  rating: number;
  rd: number;
  vol: number;
  matchCount: number;
  wins: number;
  losses: number;
  mainMatchCount: number;
  rookieMatchCount: number;
  /**
   * Dense chronological index of the last event *day* played. Decay counts
   * missed days rather than missed brackets, because the club runs a main and a
   * rookie bracket on one evening and a player can only attend one of them.
   */
  lastPeriodIndex: number;
  /** ISO date of the player's most recent set. */
  lastPlayedDate: string;
  /**
   * Consecutive club events missed since the player's last appearance. What the
   * board's activity penalty is charged on.
   */
  missedEvents: number;
  /** Unbroken run of events attended up to the club's latest; 0 once broken. */
  attendanceStreak: number;
  /** Brackets entered. */
  tournamentIds: Set<string>;
  /**
   * Events (occasions) attended. Smaller than `tournamentIds` for anyone who
   * played both the main and the rookie bracket on one evening.
   */
  eventKeys: Set<string>;
  opponentIds: Set<string>;
}

export interface ReplayResult {
  events: RatingEvent[];
  finalStates: Map<string, PlayerFinalState>;
  /** Tournament ID -> dense chronological bracket index, used for set ordering. */
  tournamentSequences: Map<string, number>;
  /** Tournament ID -> dense event-day index, used for decay counting. */
  decayPeriods: Map<string, number>;
}
