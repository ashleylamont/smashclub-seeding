import {
  bigint,
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { user } from './auth';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

// ---------------------------------------------------------------------------
// Company taxonomy (was hardcoded COMPANY_CODES/COMPANY_ALIASES)
// ---------------------------------------------------------------------------

export const companies = pgTable('companies', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  ...timestamps,
});

export const companyAliases = pgTable(
  'company_aliases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    aliasNorm: text('alias_norm').notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex('company_aliases_alias_norm_idx').on(table.aliasNorm)],
);

// ---------------------------------------------------------------------------
// Players and identity
// ---------------------------------------------------------------------------

export const playerStatusEnum = pgEnum('player_status', ['active', 'merged']);

export const players = pgTable('players', {
  id: uuid('id').primaryKey().defaultRandom(),
  canonicalName: text('canonical_name').notNull(),
  companyId: uuid('company_id').references(() => companies.id, { onDelete: 'set null' }),
  /** Claim-editable public name; falls back to canonicalName when null. */
  displayName: text('display_name'),
  /** players.yaml id, kept for import idempotency. */
  legacyId: text('legacy_id').unique(),
  status: playerStatusEnum('status').notNull().default('active'),
  mergedIntoPlayerId: uuid('merged_into_player_id'),
  ...timestamps,
});

export const aliasSourceEnum = pgEnum('alias_source', [
  'registry',
  'challonge',
  'structured',
  'manual',
  'merge_decision',
]);

export const playerAliases = pgTable(
  'player_aliases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    /** Lowercased cleaned name. */
    aliasNorm: text('alias_norm').notNull(),
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'set null' }),
    source: aliasSourceEnum('source').notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('player_aliases_norm_company_idx').on(
      table.aliasNorm,
      sql`coalesce(${table.companyId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
    ),
  ],
);

/**
 * Fighters a player mains, shown as head icons beside their name. Ordered by
 * `position` (0 = the main), so "mains Fox, secondaries Falco" survives a
 * round-trip rather than collapsing into an unordered set.
 *
 * Slugs are validated against the shared roster at the API boundary rather
 * than by a DB enum: the roster is a list of names, and a new DLC fighter
 * should not need a migration.
 */
export const playerCharacters = pgTable(
  'player_characters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    characterSlug: text('character_slug').notNull(),
    position: integer('position').notNull().default(0),
    ...timestamps,
  },
  (table) => [uniqueIndex('player_characters_player_slug_idx').on(table.playerId, table.characterSlug)],
);

export const identityDecisionKindEnum = pgEnum('identity_decision_kind', ['merge', 'keep_separate']);

/**
 * Durable record of human identity decisions (replaces the legacy alias
 * dotfiles). Crucially stores rejections too: "Josh C is NOT Josh Cortese,
 * decided once, never re-asked."
 */
export const identityDecisions = pgTable(
  'identity_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: identityDecisionKindEnum('kind').notNull(),
    aliasNorm: text('alias_norm').notNull(),
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'set null' }),
    /** Merge target; null for keep_separate. */
    playerId: uuid('player_id').references(() => players.id, { onDelete: 'cascade' }),
    /** For keep_separate: which candidate this alias was kept separate from. */
    keptSeparateFromPlayerId: uuid('kept_separate_from_player_id').references(() => players.id, {
      onDelete: 'cascade',
    }),
    decidedBy: text('decided_by').references(() => user.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('identity_decisions_scope_idx').on(
      table.aliasNorm,
      sql`coalesce(${table.companyId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      sql`coalesce(${table.keptSeparateFromPlayerId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
    ),
  ],
);

export const claimStatusEnum = pgEnum('claim_status', ['pending', 'approved', 'rejected', 'revoked']);

/**
 * User <-> player links. Many users may hold approved claims on one player
 * (e.g. unlinked work/personal accounts); a user holds at most one live
 * (pending or approved) claim overall.
 */
export const playerClaims = pgTable(
  'player_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    status: claimStatusEnum('status').notNull().default('pending'),
    note: text('note'),
    resolvedBy: text('resolved_by').references(() => user.id, { onDelete: 'set null' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('player_claims_live_per_user_idx')
      .on(table.userId)
      .where(sql`${table.status} in ('pending', 'approved')`),
  ],
);

// ---------------------------------------------------------------------------
// Tournaments and sets (the source of truth)
// ---------------------------------------------------------------------------

export const syncStateEnum = pgEnum('sync_state', ['registered', 'syncing', 'live', 'synced', 'error']);

export const tournaments = pgTable('tournaments', {
  id: uuid('id').primaryKey().defaultRandom(),
  challongeSlug: text('challonge_slug').notNull().unique(),
  challongeId: bigint('challonge_id', { mode: 'number' }),
  name: text('name').notNull(),
  /**
   * Chronological anchor driving rating order; from Challonge started_at,
   * admin-overridable.
   */
  eventDate: timestamp('event_date', { withTimezone: true }),
  /** True once an admin overrides eventDate; sync stops touching it. */
  eventDateManual: boolean('event_date_manual').notNull().default(false),
  challongeState: text('challonge_state'),
  /**
   * NOTE: the `live` enum value is retained for historical rows only. Live
   * monitoring is no longer expressed here — see `liveUntil`.
   */
  syncState: syncStateEnum('sync_state').notNull().default('registered'),
  /**
   * Live monitoring is EXPLICIT and SELF-EXPIRING: an admin starts it for a
   * bounded window and the fast poller only considers tournaments whose window
   * has not passed. It is never inferred from Challonge's `state`.
   *
   * Why: `state: underway` is sticky. Tournaments abandoned years ago still
   * report it, and the public bracket path synthesises it for any unfinished
   * bracket — so inferring "live" from state meant polling dead tournaments
   * forever.
   */
  liveUntil: timestamp('live_until', { withTimezone: true }),
  isRookie: boolean('is_rookie').notNull().default(false),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  syncError: text('sync_error'),
  raw: jsonb('raw'),
  ...timestamps,
});

export const tournamentParticipants = pgTable(
  'tournament_participants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tournamentId: uuid('tournament_id')
      .notNull()
      .references(() => tournaments.id, { onDelete: 'cascade' }),
    challongeParticipantId: bigint('challonge_participant_id', { mode: 'number' }).notNull(),
    rawName: text('raw_name').notNull(),
    cleanedName: text('cleaned_name').notNull(),
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'set null' }),
    /** Null until identity is resolved (review queue). */
    playerId: uuid('player_id').references(() => players.id, { onDelete: 'set null' }),
    challongeSeed: integer('challonge_seed'),
    finalRank: integer('final_rank'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('tournament_participants_challonge_idx').on(table.tournamentId, table.challongeParticipantId),
  ],
);

export const sets = pgTable(
  'sets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tournamentId: uuid('tournament_id')
      .notNull()
      .references(() => tournaments.id, { onDelete: 'cascade' }),
    challongeMatchId: bigint('challonge_match_id', { mode: 'number' }).notNull(),
    round: integer('round'),
    suggestedPlayOrder: integer('suggested_play_order'),
    identifier: text('identifier'),
    state: text('state').notNull(),
    p1ParticipantId: uuid('p1_participant_id').references(() => tournamentParticipants.id, {
      onDelete: 'set null',
    }),
    p2ParticipantId: uuid('p2_participant_id').references(() => tournamentParticipants.id, {
      onDelete: 'set null',
    }),
    /** Denormalised on participant resolution; both non-null => rateable. */
    p1PlayerId: uuid('p1_player_id').references(() => players.id, { onDelete: 'set null' }),
    p2PlayerId: uuid('p2_player_id').references(() => players.id, { onDelete: 'set null' }),
    winner: integer('winner'),
    scoresCsv: text('scores_csv'),
    /** DQ/forfeit sets are excluded by default; admin-overridable per set. */
    excludedFromRatings: boolean('excluded_from_ratings').notNull().default(false),
    /** True once an admin overrides the exclusion; sync stops recalculating it. */
    exclusionManual: boolean('exclusion_manual').notNull().default(false),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    raw: jsonb('raw'),
    ...timestamps,
  },
  (table) => [uniqueIndex('sets_challonge_match_idx').on(table.tournamentId, table.challongeMatchId)],
);

// ---------------------------------------------------------------------------
// Derived ratings (recomputable from sets)
// ---------------------------------------------------------------------------

export const recomputeStatusEnum = pgEnum('recompute_status', ['running', 'complete', 'failed']);

export const recomputes = pgTable('recomputes', {
  id: uuid('id').primaryKey().defaultRandom(),
  status: recomputeStatusEnum('status').notNull().default('running'),
  /**
   * Which rating model produced this run. Models run in parallel so they can be
   * compared on the same data before one becomes authoritative.
   */
  model: text('model').notNull().default('glicko2'),
  engineVersion: text('engine_version').notNull(),
  settingsSnapshot: jsonb('settings_snapshot').notNull(),
  stats: jsonb('stats'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
});

export const ratingEvents = pgTable('rating_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  recomputeId: uuid('recompute_id')
    .notNull()
    .references(() => recomputes.id, { onDelete: 'cascade' }),
  playerId: uuid('player_id')
    .notNull()
    .references(() => players.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  setId: uuid('set_id').references(() => sets.id, { onDelete: 'cascade' }),
  tournamentId: uuid('tournament_id')
    .notNull()
    .references(() => tournaments.id, { onDelete: 'cascade' }),
  isDecay: boolean('is_decay').notNull().default(false),
  won: boolean('won'),
  opponentPlayerId: uuid('opponent_player_id').references(() => players.id, { onDelete: 'cascade' }),
  preRating: doublePrecision('pre_rating').notNull(),
  postRating: doublePrecision('post_rating').notNull(),
  preRd: doublePrecision('pre_rd').notNull(),
  postRd: doublePrecision('post_rd').notNull(),
  preVol: doublePrecision('pre_vol').notNull(),
  postVol: doublePrecision('post_vol').notNull(),
  weight: doublePrecision('weight').notNull(),
});

export const playerRatings = pgTable(
  'player_ratings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recomputeId: uuid('recompute_id')
      .notNull()
      .references(() => recomputes.id, { onDelete: 'cascade' }),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    rank: integer('rank').notNull(),
    league: text('league').notNull(),
    rating: doublePrecision('rating').notNull(),
    rd: doublePrecision('rd').notNull(),
    vol: doublePrecision('vol').notNull(),
    effectiveRating: doublePrecision('effective_rating').notNull(),
    effectiveRd: doublePrecision('effective_rd').notNull(),
    /** Best estimate — what the public leaderboard ranks on. */
    skillRating: doublePrecision('skill_rating').notNull().default(1500),
    /** Uncertainty on skillRating, shown as a ± band rather than hidden. */
    skillSd: doublePrecision('skill_sd').notNull().default(350),
    /** Pessimistic estimate — what bracket seeding uses. */
    conservativeRating: doublePrecision('conservative_rating').notNull(),
    matchCount: integer('match_count').notNull(),
    wins: integer('wins').notNull(),
    losses: integer('losses').notNull(),
    mainMatchCount: integer('main_match_count').notNull(),
    rookieMatchCount: integer('rookie_match_count').notNull(),
    /** Brackets entered. */
    tournamentCount: integer('tournament_count').notNull(),
    /**
     * Events (occasions) attended — what "Events" means to a member. Lower than
     * `tournamentCount` for anyone who played both the main and the rookie
     * bracket on one evening, which is also the unit inactivity decay counts.
     */
    eventCount: integer('event_count').notNull().default(0),
    uniqueOpponentCount: integer('unique_opponent_count').notNull(),
    bridgeOpponentCount: integer('bridge_opponent_count').notNull(),
    rookieRatio: doublePrecision('rookie_ratio').notNull(),
    isolationFactor: doublePrecision('isolation_factor').notNull(),
    sampleConfidence: doublePrecision('sample_confidence').notNull(),
    lastPlayedDate: text('last_played_date').notNull(),
  },
  (table) => [uniqueIndex('player_ratings_recompute_player_idx').on(table.recomputeId, table.playerId)],
);

// ---------------------------------------------------------------------------
// Review queue (replaces the blocking CLI prompts)
// ---------------------------------------------------------------------------

export const reviewStatusEnum = pgEnum('review_status', ['pending', 'resolved', 'dismissed']);
export const reviewResolutionEnum = pgEnum('review_resolution', [
  'linked_existing',
  'created_new',
  'kept_separate',
]);

export const reviewItems = pgTable(
  'review_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tournamentParticipantId: uuid('tournament_participant_id')
      .notNull()
      .references(() => tournamentParticipants.id, { onDelete: 'cascade' }),
    rawName: text('raw_name').notNull(),
    cleanedName: text('cleaned_name').notNull(),
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'set null' }),
    /** Ranked candidates: [{ playerId, score, reason }]. */
    candidates: jsonb('candidates').notNull(),
    status: reviewStatusEnum('status').notNull().default('pending'),
    resolution: reviewResolutionEnum('resolution'),
    resolvedPlayerId: uuid('resolved_player_id').references(() => players.id, { onDelete: 'set null' }),
    resolvedBy: text('resolved_by').references(() => user.id, { onDelete: 'set null' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('review_items_pending_participant_idx')
      .on(table.tournamentParticipantId)
      .where(sql`${table.status} = 'pending'`),
  ],
);

// ---------------------------------------------------------------------------
// Seeding runs
// ---------------------------------------------------------------------------

export const seedingRunStatusEnum = pgEnum('seeding_run_status', ['draft', 'pushed', 'stale']);

export const seedingRuns = pgTable('seeding_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tournamentId: uuid('tournament_id')
    .notNull()
    .references(() => tournaments.id, { onDelete: 'cascade' }),
  recomputeId: uuid('recompute_id').references(() => recomputes.id, { onDelete: 'set null' }),
  createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
  status: seedingRunStatusEnum('status').notNull().default('draft'),
  pushedAt: timestamp('pushed_at', { withTimezone: true }),
  pushLog: jsonb('push_log'),
  ...timestamps,
});

export const seedingEntries = pgTable(
  'seeding_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => seedingRuns.id, { onDelete: 'cascade' }),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => tournamentParticipants.id, { onDelete: 'cascade' }),
    playerId: uuid('player_id').references(() => players.id, { onDelete: 'set null' }),
    autoScore: doublePrecision('auto_score'),
    autoSeed: integer('auto_seed').notNull(),
    overrideSeed: integer('override_seed'),
    locked: boolean('locked').notNull().default(false),
    ...timestamps,
  },
  (table) => [uniqueIndex('seeding_entries_run_participant_idx').on(table.runId, table.participantId)],
);

// ---------------------------------------------------------------------------
// Job log + settings
// ---------------------------------------------------------------------------

export const jobStatusEnum = pgEnum('job_status', ['running', 'complete', 'failed']);

export const syncJobs = pgTable('sync_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: text('type').notNull(),
  tournamentId: uuid('tournament_id').references(() => tournaments.id, { onDelete: 'set null' }),
  status: jobStatusEnum('status').notNull().default('running'),
  error: text('error'),
  stats: jsonb('stats'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
});

export const settings = pgTable('settings', {
  id: integer('id').primaryKey().default(1),
  glicko: jsonb('glicko').notNull(),
  version: integer('version').notNull().default(1),
  ...timestamps,
});
