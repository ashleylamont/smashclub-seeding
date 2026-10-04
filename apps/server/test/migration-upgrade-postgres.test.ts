import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { postgresCluster, migrationsFolder } from './helpers/postgres';

let cluster: Awaited<ReturnType<typeof postgresCluster>>;
beforeAll(async () => {
  cluster = await postgresCluster(false);
});
afterAll(async () => cluster?.close());

/** Real historical migration journals, rather than applying old SQL to a modern schema. */
async function upgradeTo(index: number) {
  const folder = mkdtempSync(join(tmpdir(), 'smashclub-migration-'));
  try {
    const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8'));
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= index);
    mkdirSync(join(folder, 'meta'));
    writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
    for (const entry of journal.entries)
      copyFileSync(join(migrationsFolder, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    await migrate(drizzle(cluster.pool), { migrationsFolder: folder });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

it('upgrades pre-stage history and pre-soft-lock operations, preserving data and safe restart', async () => {
  await upgradeTo(10);
  const player = (
    await cluster.pool.query(
      "INSERT INTO players (canonical_name, display_name, legacy_id) VALUES ('Synthetic competitor', 'Public alias', 'synthetic-legacy') RETURNING id",
    )
  ).rows[0].id;
  const tournament = (
    await cluster.pool.query(
      "INSERT INTO tournaments (challonge_slug, name, sync_state, raw, event_date, results_mode) VALUES ('synthetic-old', 'Old event', 'synced', '{}', '2026-09-01', 'final_stage_only') RETURNING id",
    )
  ).rows[0].id;
  await cluster.pool.query(
    "INSERT INTO sets (tournament_id, challonge_match_id, state, p1_player_id, winner, scores_csv) VALUES ($1, 7, 'complete', $2, 1, '2-1')",
    [tournament, player],
  );
  await upgradeTo(18);
  const history = (
    await cluster.pool.query('SELECT * FROM tournaments WHERE id = $1', [tournament])
  ).rows[0];
  expect(history).toMatchObject({
    sync_state: 'registered',
    results_mode: 'final_stage_only',
    last_synced_at: null,
  });
  const ids: string[] = [];
  for (const [index, name] of ['Untouched draw', 'Played draw', 'Explicit lock'].entries()) {
    const id = (
      await cluster.pool.query(
        "INSERT INTO event_plans (name, event_date, status, updated_at) VALUES ($1, '2026-09-02', 'pools_ready', '2026-09-02T08:00:00Z') RETURNING id",
        [name],
      )
    ).rows[0].id;
    ids.push(id);
    await cluster.pool.query(
      "INSERT INTO event_matches (event_plan_id, source_key, division, stage, pool_index, label, status) VALUES ($1, $2, 'upper', 'group', 0, 'Synthetic match', $3)",
      [id, `group:${index}`, index === 1 ? 'playing' : 'ready'],
    );
    await cluster.pool.query(
      "INSERT INTO event_pool_assignments (event_plan_id, player_id, division, pool_index) VALUES ($1, $2, 'upper', 0)",
      [id, player],
    );
  }
  await upgradeTo(20);
  await cluster.pool.query(
    "INSERT INTO \"user\" (id, name, email) VALUES ('synthetic-to', 'TO', 'to@example.test')",
  );
  await cluster.pool.query("UPDATE event_plans SET soft_locked_by = 'synthetic-to' WHERE id = $1", [
    ids[2],
  ]);
  await migrate(drizzle(cluster.pool), { migrationsFolder });
  const draws = (await cluster.pool.query('SELECT id, soft_locked_at FROM event_plans')).rows;
  expect(draws.find((p) => p.id === ids[0]).soft_locked_at).toBeNull();
  expect(draws.filter((p) => p.id !== ids[0]).every((p) => p.soft_locked_at !== null)).toBe(true);
  expect(
    (await cluster.pool.query('SELECT event_plan_id FROM event_matches')).rows
      .map((r) => r.event_plan_id)
      .sort(),
  ).toEqual(ids.slice(1).sort());
  expect(
    (await cluster.pool.query('SELECT event_plan_id FROM event_pool_assignments')).rows
      .map((r) => r.event_plan_id)
      .sort(),
  ).toEqual(ids.slice(1).sort());
  expect(
    (
      await cluster.pool.query(
        'SELECT canonical_name, display_name, legacy_id FROM players WHERE id = $1',
        [player],
      )
    ).rows[0],
  ).toEqual({
    canonical_name: 'Synthetic competitor',
    display_name: 'Public alias',
    legacy_id: 'synthetic-legacy',
  });
  expect(
    (
      await cluster.pool.query(
        'SELECT challonge_match_id, scores_csv, result_stage FROM sets WHERE tournament_id = $1',
        [tournament],
      )
    ).rows[0],
  ).toMatchObject({ challonge_match_id: '7', scores_csv: '2-1', result_stage: 'final' });
  const ledger = (
    await cluster.pool.query(
      'SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id',
    )
  ).rows;
  const recovered = cluster.connect();
  try {
    await migrate(drizzle(recovered.pool), { migrationsFolder });
    expect(
      (
        await recovered.pool.query(
          'SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id',
        )
      ).rows,
    ).toEqual(ledger);
    await expect(
      recovered.pool.query(
        "INSERT INTO tournaments (challonge_slug, name) VALUES ('synthetic-old', 'Duplicate')",
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      recovered.pool.query(
        "INSERT INTO event_pool_assignments (event_plan_id, player_id, division, pool_index) VALUES ($1, '00000000-0000-4000-8000-000000000000', 'upper', 0)",
        [ids[1]],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  } finally {
    await recovered.pool.end();
  }
});

it('the Docker smoke historical fixture uses the same journal hashes as production migration', async () => {
  const imageDatabase = await postgresCluster(false);
  try {
    const fixture = execFileSync(process.execPath, ['scripts/image-upgrade-fixture.mjs'], {
      encoding: 'utf8',
    });
    await imageDatabase.pool.query(fixture);
    await migrate(drizzle(imageDatabase.pool), { migrationsFolder });
    const [row] = (
      await imageDatabase.pool.query(
        "SELECT display_name FROM players WHERE canonical_name = 'Synthetic private identity'",
      )
    ).rows;
    expect(row.display_name).toBe('Synthetic public alias');
    const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8'));
    expect(
      Number(
        (await imageDatabase.pool.query('SELECT count(*) FROM drizzle.__drizzle_migrations'))
          .rows[0].count,
      ),
    ).toBe(journal.entries.length);
  } finally {
    await imageDatabase.close();
  }
});
