import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Synthetic pre-stage-aware database; the production entrypoint performs the upgrade.
const folder = 'packages/db/migrations';
const journal = JSON.parse(readFileSync(`${folder}/meta/_journal.json`, 'utf8'));
console.log(
  'CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint);',
);
for (const entry of journal.entries.filter((row) => row.idx <= 10)) {
  const sql = readFileSync(`${folder}/${entry.tag}.sql`, 'utf8');
  const hash = createHash('sha256').update(sql).digest('hex');
  console.log(
    `BEGIN;\n${sql}\nINSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('${hash}', ${entry.when});\nCOMMIT;`,
  );
}
console.log(`INSERT INTO players (id, canonical_name, display_name) VALUES ('00000000-0000-4000-8000-000000000001', 'Synthetic private identity', 'Synthetic public alias');
INSERT INTO tournaments (challonge_slug, name, event_date, sync_state, raw, results_mode) VALUES ('synthetic-upgrade', 'Synthetic historic event', '2026-09-01', 'synced', '{}', 'final_stage_only');`);
