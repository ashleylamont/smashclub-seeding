import { boolean, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
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
export const eventMatches = pgTable('event_matches', {
    id: uuid('id').primaryKey().defaultRandom(), eventPlanId: planId(), sourceKey: text('source_key').notNull(), sourceSetId: uuid('source_set_id').references(() => sets.id, { onDelete: 'set null' }),
    division: text('division').$type<'upper' | 'lower'>().notNull(), stage: text('stage').$type<'group' | 'main' | 'consolation'>().notNull(), poolIndex: integer('pool_index'), label: text('label').notNull(),
    player1Id: uuid('player1_id').references(() => players.id), player2Id: uuid('player2_id').references(() => players.id),
    score1: integer('score1'), score2: integer('score2'), winnerId: uuid('winner_id').references(() => players.id), outcome: text('outcome').$type<'played' | 'bye' | 'forfeit'>(),
    status: text('status').$type<'ready' | 'playing' | 'complete' | 'blocked'>().notNull().default('ready'), stationId: uuid('station_id').references(() => eventStations.id), blockedReason: text('blocked_reason'),
    revision: integer('revision').notNull().default(0), syncState: text('sync_state').$type<'local' | 'pending' | 'synced' | 'error'>().notNull().default('local'),
}, t => [uniqueIndex('event_matches_source_idx').on(t.eventPlanId, t.sourceKey)]);
export const eventScoreReports = pgTable('event_score_reports', {
    id: uuid('id').primaryKey().defaultRandom(), eventPlanId: planId(), matchId: uuid('match_id').notNull().references(() => eventMatches.id, { onDelete: 'cascade' }), userId: text('user_id').notNull().references(() => user.id), requestId: text('request_id').notNull(),
    expectedRevision: integer('expected_revision').notNull(), score1: integer('score1').notNull(), score2: integer('score2').notNull(), winnerId: uuid('winner_id').notNull().references(() => players.id), outcome: text('outcome').$type<'played' | 'bye' | 'forfeit'>().notNull(),
    status: text('status').$type<'pending' | 'approved' | 'rejected'>().notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('event_score_reports_request_idx').on(t.userId, t.requestId)]);
export const eventMatchAudit = pgTable('event_match_audit', {
    id: uuid('id').primaryKey().defaultRandom(), eventPlanId: planId(), matchId: uuid('match_id').notNull().references(() => eventMatches.id, { onDelete: 'cascade' }), userId: text('user_id').notNull().references(() => user.id), action: text('action').notNull(), before: jsonb('before').notNull(), after: jsonb('after').notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export const eventAnnouncements = pgTable('event_announcements', { id: uuid('id').primaryKey().defaultRandom(), eventPlanId: planId(), message: text('message').notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow() });
export const eventPrizes = pgTable('event_prizes', { id: uuid('id').primaryKey().defaultRandom(), eventPlanId: planId(), title: text('title').notNull(), description: text('description'), playerId: uuid('player_id').references(() => players.id) });
