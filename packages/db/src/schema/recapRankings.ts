import { jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tournaments } from './domain';

export const recapRankings = pgTable(
  'recap_rankings',
  {
    tournamentId: uuid('tournament_id')
      .notNull()
      .references(() => tournaments.id, { onDelete: 'cascade' }),
    inputHash: text('input_hash').notNull(),
    /** Null holds the single attempt while it is running or if it did not succeed. */
    orderedIds: jsonb('ordered_ids').$type<string[]>(),
    attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.tournamentId, table.inputHash] })],
);
