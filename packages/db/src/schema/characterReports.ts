import { jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { SetCharacterPick } from '@smashclub/shared';
import { user } from './auth';

export const setCharacterReports = pgTable(
  'set_character_reports',
  {
    // Native matches keep one identity across publication and archive copies.
    kind: text('kind').$type<'native' | 'archive'>().notNull(),
    matchId: uuid('match_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    picks: jsonb('picks').$type<SetCharacterPick[]>().notNull(),
    participantIds: jsonb('participant_ids').$type<string[]>().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.kind, table.matchId, table.userId] })],
);
