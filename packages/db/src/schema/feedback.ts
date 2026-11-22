import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const appFeedback = pgTable(
  'app_feedback',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    requestId: uuid('request_id').notNull().unique(),
    summary: text('summary').notNull(),
    description: text('description').notNull(),
    version: text('version').notNull(),
    build: text('build').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (table) => [index('app_feedback_created_at_id').on(table.createdAt, table.id)],
);
