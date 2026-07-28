/**
 * One-off bootstrap importer.
 *
 * Usage:
 *   DATABASE_URL=postgres://... pnpm --filter @smashclub/import-registry start \
 *     [--players players.yaml] [--tournaments challonge_tournaments.txt]
 *
 * Idempotent: players are keyed by their registry id, tournaments by slug,
 * companies by code. Run it again any time.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { createDb } from '@smashclub/db';
import {
  importCompanyTaxonomy,
  importRegistryPlayers,
  registerTournamentSlugs,
  type RegistryPlayerInput,
} from '@smashclub/server/bootstrap';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      players: { type: 'string' },
      tournaments: { type: 'string' },
    },
  });

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required.');
    process.exit(1);
  }
  const { db, pool } = createDb(databaseUrl);

  try {
    await importCompanyTaxonomy(db);
    console.log('Company taxonomy imported.');

    if (values.players) {
      const payload = parseYaml(readFileSync(values.players, 'utf8')) as { players?: RegistryPlayerInput[] };
      const result = await importRegistryPlayers(db, payload.players ?? []);
      console.log(`Players imported: ${result.created} created, ${result.updated} updated.`);
    }

    if (values.tournaments) {
      const lines = readFileSync(values.tournaments, 'utf8').split('\n');
      const registered = await registerTournamentSlugs(db, lines);
      console.log(`Tournaments registered: ${registered} new.`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
