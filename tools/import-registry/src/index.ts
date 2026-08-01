/**
 * One-off bootstrap importer.
 *
 * Usage:
 *   DATABASE_URL=postgres://... pnpm --filter @smashclub/import-registry start \
 *     [--players players.yaml] [--tournaments challonge_tournaments.txt]
 *
 * Idempotent: players are keyed by their registry id, tournaments by slug,
 * companies by code. Run it again any time.
 *
 * The parsing, validation and diffing are the same code the admin import
 * wizard runs (apps/server/src/registry), so a file that imports cleanly here
 * previews cleanly there and vice versa.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createDb } from '@smashclub/db';
import {
  importCompanyTaxonomy,
  importRegistryPlayers,
  parseRegistryYaml,
  registerTournamentSlugs,
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
      const parsed = parseRegistryYaml(readFileSync(values.players, 'utf8'));
      if (parsed.issues.length > 0) {
        // Refuse the whole file rather than silently importing the entries that
        // happened to be well-formed.
        console.error(`${values.players} has ${parsed.issues.length} problem(s):`);
        for (const issue of parsed.issues) {
          console.error(`  - ${issue.id ?? `entry #${issue.index + 1}`}: ${issue.message}`);
        }
        process.exit(1);
      }
      const result = await importRegistryPlayers(db, parsed.entries);
      console.log(
        `Players imported: ${result.created} created, ${result.updated} updated, ${result.unchanged} unchanged ` +
          `(+${result.aliasesAdded} aliases, +${result.charactersAdded} characters, ` +
          `+${result.companiesCreated} companies).`,
      );
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
