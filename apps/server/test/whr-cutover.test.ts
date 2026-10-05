import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq, sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import {
  schema,
  players,
  recomputes,
  tournaments,
  sets,
  tournamentParticipants,
  seedingRuns,
  seedingEntries,
  ratingEvents,
  playerRatings,
  type Db,
} from '@smashclub/db';
import { defaultRatingSettings, ratingSettingsSchema } from '@smashclub/shared';
import { getRatingSettings } from '../src/settings';
import { latestRecomputeId, runRecompute } from '../src/recompute/recompute';

const migrationsFolder = fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url));

it.each(['glicko2', 'whr'])(
  'migrates %s configuration without changing historical records or frozen seeds',
  async (oldModel) => {
    const folder = await mkdtemp(join(tmpdir(), 'whr-cutover-'));
    const client = new PGlite();
    const local = drizzle(client, { schema });
    const db = local as unknown as Db;
    try {
      const journal = JSON.parse(
        await readFile(join(migrationsFolder, 'meta/_journal.json'), 'utf8'),
      ) as { entries: { tag: string }[] };
      const cutover = journal.entries.findIndex((entry) => entry.tag.includes('whr_only'));
      expect(cutover).toBeGreaterThanOrEqual(0);
      journal.entries = journal.entries.slice(0, cutover);
      await mkdir(join(folder, 'meta'));
      await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
      await Promise.all(
        journal.entries.map((entry) =>
          copyFile(join(migrationsFolder, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`)),
        ),
      );
      await migrate(local, { migrationsFolder: folder });

      const oldSettings = {
        ...defaultRatingSettings,
        activeModel: oldModel,
        tau: 0.7,
        initialRating: 1700,
        whrPriorSd: 1.4,
        whrGamesWeight: 0.3,
        whrIsolationAnchor: true,
        activityGraceEvents: 2,
        activityPenaltyPerEvent: 25,
        activityPenaltyCap: 75,
        leagueBandsCalibrated: true,
        leagueBandBasis: 'club',
        leagueBands: [{ name: 'Club', minRating: -1_000_000 }],
      };
      await db.execute(
        sql`insert into settings (id, glicko, version) values (1, ${JSON.stringify(oldSettings)}::jsonb, 9)`,
      );
      const [a, b] = await db
        .insert(players)
        .values([{ canonicalName: 'a' }, { canonicalName: 'b' }])
        .returning();
      const [t] = await db
        .insert(tournaments)
        .values({
          challongeSlug: 'old',
          name: 'Old night',
          eventDate: new Date('2025-01-01'),
          challongeState: 'underway',
        })
        .returning();
      const [match] = await db
        .insert(sets)
        .values({
          tournamentId: t!.id,
          challongeMatchId: 1,
          state: 'complete',
          p1PlayerId: a!.id,
          p2PlayerId: b!.id,
          winner: 1,
          scoresCsv: '3-1',
        })
        .returning();
      const [oldRun] = await db
        .insert(recomputes)
        .values({
          model: oldModel,
          engineVersion: '1.0.0',
          status: 'complete',
          settingsSnapshot: { glicko: oldSettings, version: 9 },
        })
        .returning();
      const [event] = await db
        .insert(ratingEvents)
        .values({
          recomputeId: oldRun!.id,
          playerId: a!.id,
          tournamentId: t!.id,
          setId: match!.id,
          seq: 0,
          won: true,
          preRating: 1500,
          postRating: 1550,
          preRd: 350,
          postRd: 200,
          preVol: 0.06,
          postVol: 0.06,
          weight: 1,
        })
        .returning();
      const [entrant] = await db
        .insert(tournamentParticipants)
        .values({
          tournamentId: t!.id,
          challongeParticipantId: 1,
          rawName: 'a',
          cleanedName: 'a',
          playerId: a!.id,
        })
        .returning();
      const [seeding] = await db
        .insert(seedingRuns)
        .values({ tournamentId: t!.id, recomputeId: oldRun!.id, status: 'pushed' })
        .returning();
      const [seed] = await db
        .insert(seedingEntries)
        .values({
          runId: seeding!.id,
          participantId: entrant!.id,
          playerId: a!.id,
          autoScore: 1150,
          autoSeed: 1,
          overrideSeed: 2,
          locked: true,
        })
        .returning();

      await migrate(local, { migrationsFolder });
      const saved = await getRatingSettings(db);
      expect(saved).toEqual({
        rating: ratingSettingsSchema.parse(
          Object.fromEntries(
            Object.entries(oldSettings).filter(([key]) => key in defaultRatingSettings),
          ),
        ),
        version: 10,
      });
      expect(saved.rating).not.toHaveProperty('activeModel');
      expect(saved.rating).not.toHaveProperty('tau');
      expect(await latestRecomputeId(db)).toBeNull();
      expect((await db.select().from(sets))[0]).toEqual(match);
      expect((await db.select().from(recomputes))[0]).toEqual(oldRun);
      expect((await db.select().from(ratingEvents))[0]).toEqual(event);

      const run = await runRecompute(db);
      expect(run.model).toBe('whr');
      expect(await latestRecomputeId(db)).toBe(run.recomputeId);
      expect(
        await db.select().from(playerRatings).where(eq(playerRatings.recomputeId, run.recomputeId)),
      ).toHaveLength(2);
      expect((await db.select().from(seedingRuns))[0]).toEqual(seeding);
      expect((await db.select().from(seedingEntries))[0]).toEqual(seed);
      expect((await db.select().from(recomputes).where(eq(recomputes.id, oldRun!.id)))[0]).toEqual(
        oldRun,
      );
      expect(
        (await db.select().from(ratingEvents).where(eq(ratingEvents.id, event!.id)))[0],
      ).toEqual(event);
      // Reapplying the migration through the journal does not bump configuration again.
      await migrate(local, { migrationsFolder });
      expect((await getRatingSettings(db)).version).toBe(10);
    } finally {
      await client.close();
      await rm(folder, { recursive: true, force: true });
    }
  },
);

it('rejects removed rating configuration instead of silently defaulting it', () => {
  expect(ratingSettingsSchema.safeParse({ activeModel: 'glicko2' }).success).toBe(false);
  expect(ratingSettingsSchema.safeParse({ tau: 0.6 }).success).toBe(false);
  expect(ratingSettingsSchema.safeParse({ whrPriorSd: 0 }).success).toBe(false);
});
