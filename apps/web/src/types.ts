export interface PlayerScore {
  system: string;
  rating: number | null;
  effective_rating: number | null;
  rating_adjustment: number | null;
  conservative_rating: number | null;
  rd: number | null;
  raw_rd: number | null;
  volatility: number | null;
  wins: number;
  losses: number;
  match_count: number;
  num_tournaments: number;
  main_match_count: number;
  rookie_match_count: number;
  rookie_ratio: number;
  unique_opponent_count: number;
  bridge_opponent_count: number;
  isolation_factor: number;
  sample_confidence: number | null;
  most_recent_tournament_date: string | null;
  peak_bonus: number;
  // Legacy fields that may be null (were Infinity)
  '1v1_score'?: number | null;
  '2v2_score'?: number | null;
  best_placement?: number | null;
  most_recent_placement?: number | null;
}

export interface PlayerRanking {
  seed: number;
  name: string;
  company: string;
  has_history: boolean;
  query_alias_used: { name: string; company: string } | null;
  league?: string;  // e.g., "Champions (1450 CR)"
  score: PlayerScore;
}

export interface MatchHistoryRow {
  processing_index: number;
  tournament_index: number;
  date: string;
  tournament: string;
  format: string;
  player_name: string;
  company: string;
  opponent_name: string;
  opponent_company: string;
  won: number; // 1 or 0 in the CSV
  pre_rating: number;
  post_rating: number;
  pre_rd: number;
  post_rd: number;
  pre_volatility: number;
  post_volatility: number;
  is_decay_snapshot?: number; // 0 or 1
  rating_change_weight?: number; // 0-1, inverse-diminishing weight
}
