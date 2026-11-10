import { sql } from 'drizzle-orm';
import { jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { user } from './auth';
import { players } from './domain';

export const claimStatusEnum = pgEnum('claim_status', [
  'pending',
  'approved',
  'rejected',
  'revoked',
]);

export type JevClaimReview =
  | { result: 'unavailable'; reviewedAt: string; rubricVersion: 1 }
  | {
      result: 'likely_match' | 'manual_review';
      reviewedAt: string;
      rubricVersion: 1;
      model: string;
      score: number;
      confidence: number;
      topLevelProbability: number;
    };

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
    jevReview: jsonb('jev_review').$type<JevClaimReview>(),
    resolvedBy: text('resolved_by').references(() => user.id, { onDelete: 'set null' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('player_claims_live_per_user_idx')
      .on(table.userId)
      .where(sql`${table.status} in ('pending', 'approved')`),
  ],
);
