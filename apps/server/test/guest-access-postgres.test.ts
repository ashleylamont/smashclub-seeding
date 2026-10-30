import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PostgresStore } from '@rotorsoft/act-pg';
import type { Db } from '@smashclub/db';
import { migrationsFolder, postgresCluster } from './helpers/postgres';
import { nativeAdmin, seedNativeDraft } from './helpers/nativeLiveFixture';
import { createNativeRuntime, type NativeRuntime } from '../src/tournament/runtime';
import { appRouter } from '../src/trpc/router';
import { loadEnv } from '../src/env';
import { ChallongeClient } from '../src/challonge/client';
import { RecomputeTrigger } from '../src/recompute/trigger';

let cluster: Awaited<ReturnType<typeof postgresCluster>>;
let legacyPlan: string;
const legacyExpiry = '2026-10-31T10:00:00.000Z';
const runtimes: NativeRuntime[] = [];
beforeAll(async () => {
  cluster = await postgresCluster(false);
  const folder = mkdtempSync(join(tmpdir(), 'smashclub-guest-upgrade-'));
  try {
    const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8'));
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 26);
    mkdirSync(join(folder, 'meta'));
    writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
    for (const entry of journal.entries)
      copyFileSync(join(migrationsFolder, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    await migrate(drizzle(cluster.pool), { migrationsFolder: folder });
    legacyPlan = (
      await cluster.pool.query(
        "INSERT INTO event_plans (name, event_date) VALUES ('Legacy guest night', '2026-10-31') RETURNING id",
      )
    ).rows[0].id;
    await cluster.pool.query(
      'INSERT INTO event_guest_settings (event_plan_id, enabled, secret) VALUES ($1, true, $2)',
      [legacyPlan, 'synthetic-legacy-secret'],
    );
    await cluster.pool.query(
      'INSERT INTO event_guest_sessions (event_plan_id, token_hash, generation, expires_at) VALUES ($1, $2, $3, $4)',
      [legacyPlan, 'synthetic-token-digest', 'synthetic-generation', legacyExpiry],
    );
    await migrate(drizzle(cluster.pool), { migrationsFolder });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
afterAll(async () => {
  for (const runtime of runtimes) await runtime.shutdown();
  await cluster?.close();
});

it('upgrades issued passes without extending their expiry or changing existing QR modes, and allows durable new passes', async () => {
  const settings = (
    await cluster.pool.query(
      'SELECT secret, rotate_invitations FROM event_guest_settings WHERE event_plan_id = $1',
      [legacyPlan],
    )
  ).rows[0];
  expect(settings).toEqual({ secret: 'synthetic-legacy-secret', rotate_invitations: true });
  const session = (
    await cluster.pool.query(
      'SELECT token_hash, generation, expires_at FROM event_guest_sessions WHERE event_plan_id = $1',
      [legacyPlan],
    )
  ).rows[0];
  expect(session).toEqual({
    token_hash: 'synthetic-token-digest',
    generation: 'synthetic-generation',
    expires_at: new Date(legacyExpiry),
  });
  const freshPlan = (
    await cluster.pool.query(
      "INSERT INTO event_plans (name, event_date) VALUES ('Durable night', '2026-11-01') RETURNING id",
    )
  ).rows[0].id;
  expect(
    (
      await cluster.pool.query(
        "INSERT INTO event_guest_settings (event_plan_id, secret) VALUES ($1, 'synthetic-new-secret') RETURNING rotate_invitations",
        [freshPlan],
      )
    ).rows[0].rotate_invitations,
  ).toBe(false);
  expect(
    (
      await cluster.pool.query(
        "INSERT INTO event_guest_sessions (event_plan_id, token_hash, generation, expires_at) VALUES ($1, 'new-digest', 'new-generation', NULL) RETURNING expires_at",
        [freshPlan],
      )
    ).rows[0].expires_at,
  ).toBeNull();
  const ledger = (
    await cluster.pool.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')
  ).rows;
  await migrate(drizzle(cluster.pool), { migrationsFolder });
  expect(
    (await cluster.pool.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')).rows,
  ).toEqual(ledger);
});

async function nativeRuntime(db: Db) {
  const store = new PostgresStore({
    connectionString: cluster.connectionString,
    schema: 'native_act',
    table: 'events',
  });
  await store.seed();
  const runtime = createNativeRuntime(db, store);
  runtimes.push(runtime);
  return runtime;
}
function caller(db: Db, runtime: NativeRuntime, user: typeof nativeAdmin | null = nativeAdmin) {
  return appRouter.createCaller({
    db,
    nativeRuntime: runtime,
    user,
    env: loadEnv({ DATABASE_URL: cluster.connectionString, NODE_ENV: 'test' }),
    challonge: new ChallongeClient({}),
    recomputeTrigger: new RecomputeTrigger(db),
  });
}

it('orders native guest commits and reset across independent SQL connections and Act runtimes', async () => {
  const second = cluster.connect();
  const runtime = await nativeRuntime(cluster.db);
  const otherRuntime = await nativeRuntime(second.db);
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const commandEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let submit: Promise<unknown> | undefined;
  let reset: Promise<unknown> | undefined;
  try {
    const planId = await seedNativeDraft(cluster.db);
    const operator = caller(cluster.db, runtime);
    await operator.eventOps.softLockPools({ planId, confirm: true });
    await operator.eventOps.settings({ planId, published: true, playerReports: false });
    await operator.eventOps.guests.configure({ planId, enabled: true, showOnOverlay: false });
    const invitation = await operator.eventOps.guests.invitation({ planId });
    const anonymous = caller(cluster.db, runtime, null);
    const pass = await anonymous.eventOps.guests.redeem({ planId, token: invitation!.token });
    const match = (await anonymous.eventOps.guests.matches({ planId, ...pass })).matches.find(
      (m) => m.status === 'ready',
    )!;
    const input = {
      planId,
      ...pass,
      matchId: match.id,
      expectedRevision: match.revision,
      requestId: 'before-reset',
      score1: 2,
      score2: 0,
    };
    const original = runtime.command;
    const intercept = vi.spyOn(runtime, 'command').mockImplementation(async (...args) => {
      entered();
      await released;
      return original(...args);
    });
    submit = anonymous.eventOps.guests.submit(input);
    await commandEntered;
    reset = caller(second.db, otherRuntime).eventOps.guests.rotate({ planId });
    const deadline = Date.now() + 5000;
    for (;;) {
      const locks = await cluster.pool.query(
        "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
      );
      if (Number(locks.rows[0].count) > 0) break;
      if (Date.now() > deadline)
        throw new Error('Guest reset did not wait for the validated command to commit');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    release();
    expect(await submit).toMatchObject({ status: 'approved' });
    await reset;
    intercept.mockRestore();
    const committed = await runtime.state(planId);
    expect(committed.reports).toHaveLength(1);
    await expect(
      anonymous.eventOps.guests.submit({ ...input, requestId: 'after-reset' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await otherRuntime.state(planId)).reports).toHaveLength(1);
    const publicView = await caller(second.db, otherRuntime, null).eventOps.snapshot({ planId });
    expect(publicView.matches.find((m) => m.id === match.id)).toMatchObject({
      score1: 2,
      score2: 0,
      status: 'complete',
    });
    expect(JSON.stringify(await runtime.replay(planId))).not.toContain(pass.sessionToken);
  } finally {
    release();
    await Promise.allSettled([submit, reset]);
    vi.restoreAllMocks();
    await otherRuntime.shutdown();
    runtimes.splice(runtimes.indexOf(otherRuntime), 1);
    await second.pool.end();
  }
});
