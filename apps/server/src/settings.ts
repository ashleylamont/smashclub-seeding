import { eq, sql } from 'drizzle-orm';
import type { Db } from '@smashclub/db';
import { settings } from '@smashclub/db';
import {
  defaultRatingSettings,
  ratingSettingsSchema,
  type RatingSettings,
} from '@smashclub/shared';

export async function getRatingSettings(
  db: Db,
): Promise<{ rating: RatingSettings; version: number }> {
  const [row] = await db.select().from(settings).where(eq(settings.id, 1));
  if (!row) {
    await db
      .insert(settings)
      .values({ id: 1, rating: defaultRatingSettings, version: 1 })
      .onConflictDoNothing();
    return getRatingSettings(db);
  }
  return { rating: ratingSettingsSchema.parse(row.rating), version: row.version };
}

export async function updateRatingSettings(db: Db, rating: RatingSettings): Promise<number> {
  const parsed = ratingSettingsSchema.parse(rating);
  await getRatingSettings(db);
  const [row] = await db
    .update(settings)
    .set({ rating: parsed, version: sql`${settings.version} + 1`, updatedAt: new Date() })
    .where(eq(settings.id, 1))
    .returning({ version: settings.version });
  return row!.version;
}
