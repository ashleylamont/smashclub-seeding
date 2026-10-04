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
  /** Rookie bracket metadata for debut priors and participation policy. */
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
  /** Games won by each side for WHR evidence weighting; absent means unknown. */
  p1Games?: number | null;
  p2Games?: number | null;
  /** Unplayed outcomes can advance a bracket but never enter a rating fit. */
  outcome?: 'played' | 'forfeit' | 'bye';
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
  /** Pre-night estimate, repeated on each set; never a sequential set delta. */
  preRating: number;
  /** Post-night prefix estimate, repeated on each set. */
  postRating: number;
  preRd: number;
  postRd: number;
  preVol: number;
  postVol: number;
  /** WHR evidence weight for this played set. */
  weight: number;
  /** Current full-history estimate at this night; may revise with later evidence. */
  revisedRating?: number;
  revisedSd?: number;
}
