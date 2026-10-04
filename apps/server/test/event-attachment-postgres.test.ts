/**
 * Mandatory real multi-connection regression. PGlite serialises transactions,
 * so it cannot reproduce this cross-plan race. This creates its OWN temporary
 * cluster and Unix socket; it never accepts an external database URL.
 *
 * pnpm test:postgres
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { postgresCluster } from './helpers/postgres';
import { eq } from 'drizzle-orm';
import { eventPlanBrackets, eventPlans, tournaments, type Db } from '@smashclub/db';
import type { Pool, PoolClient } from 'pg';
import { attachBracket } from '../src/event-planner/plans';

describe('bracket ownership under real PostgreSQL concurrency', () => {
  let cluster: Awaited<ReturnType<typeof postgresCluster>>;
  let db: Db;
  let pool: Pool;
  beforeAll(async () => {
    cluster = await postgresCluster();
    ({ db, pool } = cluster);
  });
  afterAll(async () => cluster?.close());

  async function plan(name: string, day: number) {
    const [row] = await db
      .insert(eventPlans)
      .values({ name, eventDate: new Date(`2026-09-${day}T00:00:00Z`), status: 'pools_ready' })
      .returning();
    await db
      .insert(eventPlanBrackets)
      .values({ eventPlanId: row!.id, division: 'upper', stage: 'main' });
    return row!;
  }

  async function waitForTwoContenders(locker: PoolClient) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      await locker.query('SELECT pg_stat_clear_snapshot()');
      const result = await locker.query<{ count: string }>(
        "select count(*)::text as count from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()",
      );
      if (Number(result.rows[0]!.count) >= 2) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const state = await locker.query(
      'select state, wait_event_type, query from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()',
    );
    throw new Error(
      `Both attachment transactions did not reach the deliberate lock barrier: ${JSON.stringify(state.rows)}`,
    );
  }

  it.each(['existing', 'new'] as const)(
    'allows one owner when two plans attach the same %s slug concurrently',
    async (state) => {
      const slug = `concurrent_${state}`;
      const first = await plan(`First ${state}`, 18);
      const second = await plan(`Second ${state}`, 19);
      const locker = await pool.connect();
      if (state === 'existing')
        await db.insert(tournaments).values({ challongeSlug: slug, name: 'Already registered' });
      await locker.query('BEGIN');
      // Existing slug: both old implementations passed the ownership read and
      // then blocked on date UPDATE here. New slug: both wait for the unique key.
      if (state === 'existing')
        await locker.query('SELECT id FROM tournaments WHERE challonge_slug = $1 FOR UPDATE', [
          slug,
        ]);
      else
        await locker.query('INSERT INTO tournaments (challonge_slug, name) VALUES ($1, $2)', [
          slug,
          'Concurrent registration',
        ]);
      const attempts = Promise.allSettled([
        attachBracket(db, first.id, 'upper', 'main', slug),
        attachBracket(db, second.id, 'upper', 'main', slug),
      ]);
      try {
        await waitForTwoContenders(locker);
      } finally {
        await locker.query('COMMIT');
        locker.release();
      }
      const results = await attempts;
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find(
        (result) => result.status === 'rejected',
      ) as PromiseRejectedResult;
      expect(rejected.reason.message).toContain('already attached');
      const links = await db
        .select()
        .from(eventPlanBrackets)
        .where(eq(eventPlanBrackets.challongeSlug, slug));
      expect(links).toHaveLength(1);
      const [tournament] = await db
        .select()
        .from(tournaments)
        .where(eq(tournaments.challongeSlug, slug));
      const winner = links[0]!.eventPlanId === first.id ? first : second;
      expect(tournament!.eventDate!.toISOString()).toBe(winner.eventDate.toISOString());
    },
  );
});
