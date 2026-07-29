import { eq } from 'drizzle-orm';
import type { Db } from '@smashclub/db';
import { settings } from '@smashclub/db';
import { defaultGlickoSettings, glickoSettingsSchema, type GlickoSettings } from '@smashclub/shared';

export async function getGlickoSettings(db: Db): Promise<{ glicko: GlickoSettings; version: number }> {
  const [row] = await db.select().from(settings).where(eq(settings.id, 1));
  if (!row) {
    await db
      .insert(settings)
      .values({ id: 1, glicko: defaultGlickoSettings, version: 1 })
      .onConflictDoNothing();
    return { glicko: defaultGlickoSettings, version: 1 };
  }
  return { glicko: glickoSettingsSchema.parse(row.glicko), version: row.version };
}

export async function updateGlickoSettings(db: Db, glicko: GlickoSettings): Promise<number> {
  const parsed = glickoSettingsSchema.parse(glicko);
  const current = await getGlickoSettings(db);
  const version = current.version + 1;
  await db
    .update(settings)
    .set({ glicko: parsed, version, updatedAt: new Date() })
    .where(eq(settings.id, 1));
  return version;
}
