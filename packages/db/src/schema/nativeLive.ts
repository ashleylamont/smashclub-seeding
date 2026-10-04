import { integer, jsonb, pgTable, timestamp, uuid, uniqueIndex } from 'drizzle-orm/pg-core';
import { eventPlans, recomputes } from './domain';

/** Immutable SQL -> Act transfer; restrict deletion so planning cannot erase history. */
export const nativeLiveHandoffs = pgTable('native_live_handoffs', {
  eventPlanId: uuid('event_plan_id')
    .primaryKey()
    .references(() => eventPlans.id),
  baseline: jsonb('baseline').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const nativeResultPublications = pgTable(
  'native_result_publications',
  {
    resultId: uuid('result_id').primaryKey(),
    eventPlanId: uuid('event_plan_id')
      .notNull()
      .references(() => nativeLiveHandoffs.eventPlanId),
    revision: integer('revision').notNull(),
    result: jsonb('result').notNull(),
    tournamentIds: jsonb('tournament_ids').$type<string[]>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('native_result_publications_revision_idx').on(t.eventPlanId, t.revision)],
);

/** Durable work, acknowledged only after WHR completes successfully. */
export const nativeRatingIntents = pgTable('native_rating_intents', {
  resultId: uuid('result_id')
    .primaryKey()
    .references(() => nativeResultPublications.resultId),
  recomputeId: uuid('recompute_id').references(() => recomputes.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});
