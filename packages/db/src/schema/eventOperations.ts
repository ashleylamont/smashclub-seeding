import { boolean, check, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { eventPlans, players, sets } from './domain';
import { user } from './auth';
const planId = () => uuid('event_plan_id').notNull().references(() => eventPlans.id, { onDelete: 'cascade' });
export const eventOperationSettings = pgTable('event_operation_settings', {
    eventPlanId: planId().primaryKey(), published: boolean('published').notNull().default(false), playerReports: boolean('player_reports').notNull().default(false),
});
export const eventOperators = pgTable('event_operators', {
    id: uuid('id').primaryKey().defaultRandom(), eventPlanId: planId(), userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
}, t => [uniqueIndex('event_operators_user_idx').on(t.eventPlanId, t.userId)]);
export const eventStations = pgTable('event_stations', { id: uuid('id').primaryKey().defaultRandom(), eventPlanId: planId(), name: text('name').notNull() });
export const eventNativeBrackets = pgTable('event_native_brackets', {
    id: uuid('id').primaryKey().defaultRandom(), eventPlanId: planId(),
    division: text('division').$type<'upper' | 'lower'>().notNull(), stage: text('stage').$type<'main' | 'consolation'>().notNull(),
    entrantIds: jsonb('entrant_ids').$type<string[]>().notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('event_native_brackets_slot_idx').on(t.eventPlanId, t.division, t.stage)]);
export const eventMatches = pgTable('event_matches', {
    nativeBracketId: uuid('native_bracket_id').references(() => eventNativeBrackets.id, { onDelete: 'cascade' }),
    nativeRound: integer('native_round'), nativeSlot: integer('native_slot'),
    parent1MatchId: uuid('parent1_match_id').references((): AnyPgColumn => eventMatches.id),
    parent2MatchId: uuid('parent2_match_id').references((): AnyPgColumn => eventMatches.id),
    id: uuid('id').primaryKey().defaultRandom(), eventPlanId: planId(), sourceKey: text('source_key').notNull(), sourceSetId: uuid('source_set_id').references(() => sets.id, { onDelete: 'set null' }),
    division: text('division').$type<'upper' | 'lower'>().notNull(), stage: text('stage').$type<'group' | 'main' | 'consolation'>().notNull(), poolIndex: integer('pool_index'), label: text('label').notNull(),
    player1Id: uuid('player1_id').references(() => players.id), player2Id: uuid('player2_id').references(() => players.id),
    score1: integer('score1'), score2: integer('score2'),
    liveScore1: integer('live_score1'), liveScore2: integer('live_score2'), winnerId: uuid('winner_id').references(() => players.id), outcome: text('outcome').$type<'played' | 'bye' | 'forfeit'>(),
    status: text('status').$type<'ready' | 'playing' | 'complete' | 'blocked'>().notNull().default('ready'), stationId: uuid('station_id').references(() => eventStations.id), blockedReason: text('blocked_reason'),
    resultUpdatedAt: timestamp('result_updated_at', { withTimezone: true }),
    revision: integer('revision').notNull().default(0), syncState: text('sync_state').$type<'local' | 'pending' | 'synced' | 'error'>().notNull().default('local'),
}, t => [uniqueIndex('event_matches_source_idx').on(t.eventPlanId, t.sourceKey)]);
export const eventScoreReports = pgTable('event_score_reports', {
    id: uuid('id').primaryKey().defaultRandom(), eventPlanId: planId(), matchId: uuid('match_id').notNull().references(() => eventMatches.id, { onDelete: 'cascade' }), userId: text('user_id').references(() => user.id), guestSessionId: uuid('guest_session_id').references(() => eventGuestSessions.id), requestId: text('request_id').notNull(),
    expectedRevision: integer('expected_revision').notNull(), score1: integer('score1').notNull(), score2: integer('score2').notNull(), winnerId: uuid('winner_id').notNull().references(() => players.id), outcome: text('outcome').$type<'played' | 'bye' | 'forfeit'>().notNull(),
    status: text('status').$type<'pending' | 'approved' | 'rejected'>().notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('event_score_reports_request_idx').on(t.userId, t.requestId), uniqueIndex('event_score_reports_guest_request_idx').on(t.guestSessionId, t.requestId), check('event_score_reports_one_reporter', sql`(${t.userId} IS NULL) <> (${t.guestSessionId} IS NULL)`)]);
export const eventMatchAudit = pgTable('event_match_audit', {
    id: uuid('id').primaryKey().defaultRandom(), eventPlanId: planId(), matchId: uuid('match_id').notNull().references(() => eventMatches.id, { onDelete: 'cascade' }), userId: text('user_id').notNull().references(() => user.id), action: text('action').notNull(), before: jsonb('before').notNull(), after: jsonb('after').notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export const eventAnnouncements = pgTable('event_announcements', { id: uuid('id').primaryKey().defaultRandom(), eventPlanId: planId(), message: text('message').notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), expiresAt:timestamp('expires_at',{withTimezone:true}) });
export const eventPrizes = pgTable('event_prizes', { id: uuid('id').primaryKey().defaultRandom(), eventPlanId: planId(), title: text('title').notNull(), description: text('description'), playerId: uuid('player_id').references(() => players.id) });
/** Stable membership after an attendance change; all pools are snapshotted together. */
export const eventPoolAssignments = pgTable('event_pool_assignments', {
    id: uuid('id').primaryKey().defaultRandom(), eventPlanId: planId(), playerId: uuid('player_id').notNull().references(() => players.id), division: text('division').$type<'upper' | 'lower'>().notNull(), poolIndex: integer('pool_index').notNull(),
}, t => [uniqueIndex('event_pool_assignments_player_idx').on(t.eventPlanId, t.playerId)]);
export const eventWithdrawals = pgTable('event_withdrawals', {
    id: uuid('id').primaryKey().defaultRandom(), eventPlanId: planId(), playerId: uuid('player_id').notNull().references(() => players.id), reason: text('reason').notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('event_withdrawals_player_idx').on(t.eventPlanId, t.playerId)]);
export const eventAttendanceAudit = pgTable('event_attendance_audit', {
    id: uuid('id').primaryKey().defaultRandom(), eventPlanId: planId(), userId: text('user_id').notNull().references(() => user.id), action: text('action').notNull(), details: jsonb('details').notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Never expose the event secret, session digest or request fingerprints publicly. */
export const eventGuestSettings = pgTable('event_guest_settings', {
    eventPlanId: planId().primaryKey(), enabled: boolean('enabled').notNull().default(false), showOnOverlay: boolean('show_on_overlay').notNull().default(false), secret: text('secret').notNull(),
});
export const eventGuestSessions = pgTable('event_guest_sessions', {
    id: uuid('id').primaryKey().defaultRandom(), eventPlanId: planId(), tokenHash: text('token_hash').notNull(), generation: text('generation').notNull(), expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('event_guest_sessions_token_idx').on(t.tokenHash)]);
export const eventGuestRateLimits = pgTable('event_guest_rate_limits', {
    key: text('key').primaryKey(), eventPlanId: planId(), count: integer('count').notNull(), expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

/** Absent schedule means active and unrestricted, preserving existing events. */
export const eventPoolSchedules = pgTable('event_pool_schedules', {
    id:uuid('id').primaryKey().defaultRandom(), eventPlanId:planId(),
    division:text('division').$type<'upper'|'lower'>().notNull(),poolIndex:integer('pool_index').notNull(),
    active:boolean('active').notNull().default(true),stationIds:jsonb('station_ids').$type<string[]>().notNull().default([]),revision:integer('revision').notNull().default(1),
},t=>[uniqueIndex('event_pool_schedules_pool_idx').on(t.eventPlanId,t.division,t.poolIndex)]);
