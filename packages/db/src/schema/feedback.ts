import { boolean, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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

export const appFeedbackIssues = pgTable(
  'app_feedback_issues',
  {
    requestId: uuid('request_id').primaryKey(),
    fingerprint: text('fingerprint').notNull(),
    marker: uuid('marker').defaultRandom().notNull(),
    issueNumber: integer('issue_number'),
    rejected: boolean('rejected').notNull().default(false),
    claimedAt: timestamp('claimed_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    checks: integer('checks').notNull().default(0),
    checkedAt: timestamp('checked_at', { withTimezone: true, precision: 3 }),
    rateBucket: text('rate_bucket'),
  },
  (table) => [
    index('app_feedback_issues_claimed_at').on(table.claimedAt),
    index('app_feedback_issues_rate_bucket').on(table.rateBucket, table.claimedAt),
  ],
);
