import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { createAuth } from '../src/auth';
import { loadEnv } from '../src/env';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { fixtureClient } from './helpers/challongeFixtures';
import { postgresCluster } from './helpers/postgres';

let cluster: Awaited<ReturnType<typeof postgresCluster>>;
let secondConnection: ReturnType<Awaited<ReturnType<typeof postgresCluster>>['connect']>;
let app: FastifyInstance;
let secondApp: FastifyInstance;
let adminCookie: string;
let memberCookie: string;
const origin = 'http://localhost:5173';
const password = 'synthetic-fixture-password';

beforeAll(async () => {
  cluster = await postgresCluster();
  secondConnection = cluster.connect();
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: cluster.connectionString,
    BETTER_AUTH_SECRET: 'synthetic-fixture-auth-secret',
    BETTER_AUTH_URL: origin,
  });
  const createApp = (db: typeof cluster.db) =>
    buildApp({
      db,
      env,
      auth: createAuth(db, env, { enableCredentials: true }),
      challonge: fixtureClient([]),
      recomputeTrigger: new RecomputeTrigger(db),
    });
  app = await createApp(cluster.db);
  secondApp = await createApp(secondConnection.db);
  async function signIn(role: 'admin' | 'user') {
    const auth = createAuth(cluster.db, env, { enableCredentials: true });
    const email = `${role}@example.test`;
    await auth.api.signUpEmail({ body: { email, name: 'Synthetic example', password } });
    await cluster.pool.query(
      'UPDATE "user" SET role = $1, email_verified = true WHERE email = $2',
      [role, email],
    );
    const response = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
    return response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(';')[0])
      .join('; ');
  }
  adminCookie = await signIn('admin');
  memberCookie = await signIn('user');
  await cluster.pool.query(`
    WITH plan AS (
      INSERT INTO event_plans (name, event_date)
      VALUES ('Synthetic organiser test', '2026-10-04')
      RETURNING id
    )
    INSERT INTO event_operators (event_plan_id, user_id)
    SELECT plan.id, "user".id FROM plan, "user" WHERE email = 'user@example.test'
  `);
});

beforeEach(async () => {
  await cluster.pool.query('TRUNCATE app_feedback');
});

afterAll(async () => {
  await Promise.all([app?.close(), secondApp?.close()]);
  await secondConnection?.pool.end();
  await cluster?.close();
});

function report() {
  return {
    requestId: randomUUID(),
    summary: ' Synthetic report ',
    description: ' Example steps to reproduce\nMade up for the test. ',
    version: '1.2.3',
    build: '1a2b3c4',
  };
}

function send(payload: object | string, target = app, headers: Record<string, string> = {}) {
  return target.inject({
    method: 'POST',
    url: '/api/feedback',
    headers: {
      host: 'localhost:5173',
      origin,
      'content-type': 'application/json',
      ...headers,
    },
    payload,
  });
}

function inbox(cookie?: string, cursor?: unknown) {
  const input = cursor ? `?input=${encodeURIComponent(JSON.stringify({ cursor }))}` : '';
  return app.inject({
    method: 'GET',
    url: `/api/trpc/admin.feedbackInbox${input}`,
    headers: cookie ? { cookie } : {},
  });
}

it('stores only the form and visible build, returns a durable reference, and restricts inbox reads', async () => {
  const payload = report();
  const responses = await Promise.all([
    send(payload, app, { cookie: memberCookie, referer: `${origin}/private?guest=example` }),
    send(payload, secondApp),
  ]);
  expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 201]);
  const reference = responses[0]?.json().reference;
  expect(reference).toMatch(/^[0-9a-f-]{36}$/);
  expect(reference).not.toBe(payload.requestId);
  expect(responses[0]?.json()).toEqual({ reference });
  expect(responses[1]?.json()).toEqual({ reference });
  expect(responses[0]?.headers['cache-control']).toBe('no-store');
  expect((await inbox()).statusCode).toBe(401);
  expect((await inbox(memberCookie)).statusCode).toBe(403);

  const privateInbox = await inbox(adminCookie);
  expect(privateInbox.statusCode).toBe(200);
  expect(privateInbox.headers['cache-control']).toBe('no-store');
  expect(privateInbox.json().result.data).toEqual({
    reports: [
      {
        reference,
        summary: payload.summary.trim(),
        description: payload.description.trim(),
        version: payload.version,
        build: payload.build,
        createdAt: expect.any(String),
      },
    ],
    nextCursor: null,
  });
  const row = (await cluster.pool.query('SELECT * FROM app_feedback')).rows[0];
  expect(Object.keys(row).sort()).toEqual([
    'build',
    'created_at',
    'description',
    'id',
    'request_id',
    'summary',
    'version',
  ]);
  expect(row.id).toBe(reference);
  expect(row.request_id).toBe(payload.requestId);
  expect(await send({ ...payload, summary: 'Edited text' })).toMatchObject({ statusCode: 409 });
  expect((await app.inject({ method: 'GET', url: '/api/feedback' })).statusCode).toBe(404);
});

it('rejects extra metadata, invalid builds, cross-origin and malformed or oversized submissions', async () => {
  const badRequests = await Promise.all([
    send({ ...report(), url: 'https://example.test/private' }),
    send({ ...report(), build: 'https://example.test' }),
    send({ ...report(), version: '1.0.0 private' }),
    send({ ...report(), summary: '   ' }),
    send({ ...report(), description: '\u0000' }),
    send({ ...report(), description: 'x'.repeat(4001) }),
    send('{"summary":"unclosed payload'),
    send({ ...report(), description: 'x'.repeat(40_000) }),
    send(report(), app, { 'content-type': 'text/plain' }),
    send(report(), app, { origin: 'https://example.test' }),
    send(report(), app, { origin: 'null' }),
    send(report(), app, { origin: '' }),
    send(report(), app, { 'sec-fetch-site': 'same-site' }),
  ]);
  expect(badRequests.map((response) => response.statusCode)).toEqual([
    400, 400, 400, 400, 400, 400, 400, 413, 415, 403, 403, 403, 403,
  ]);
  expect((await cluster.pool.query('SELECT count(*) FROM app_feedback')).rows[0].count).toBe('0');
});

it('allows distinct reports at one address and limits the rolling volume across connections', async () => {
  const first = report();
  expect((await send(first)).statusCode).toBe(201);
  const sameAddress = await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      send({ ...report(), summary: `Another anonymous report ${index}` }),
    ),
  );
  expect(sameAddress.every((response) => response.statusCode === 201)).toBe(true);
  await cluster.pool.query(`
    INSERT INTO app_feedback (request_id, summary, description, version, build)
    SELECT gen_random_uuid(), 'Example', 'Synthetic', '1.2.3', 'dev'
    FROM generate_series(1, 52)
  `);
  const concurrent = await Promise.all([send(report()), send(report(), secondApp)]);
  expect(concurrent.map((response) => response.statusCode).sort()).toEqual([201, 429]);
  expect(concurrent.find((response) => response.statusCode === 429)?.headers['retry-after']).toBe(
    '3600',
  );
  expect((await send(first, secondApp)).statusCode).toBe(200);

  await cluster.pool.query("UPDATE app_feedback SET created_at = now() - interval '2 hours'");
  await cluster.pool.query(`
    INSERT INTO app_feedback (request_id, summary, description, version, build, created_at)
    SELECT gen_random_uuid(), 'Example', 'Synthetic', '1.2.3', 'dev', now() - interval '2 hours'
    FROM generate_series(1, 140)
  `);
  expect((await send(report())).statusCode).toBe(429);
});

it('expires old reports and pages past identical timestamps without missing references', async () => {
  await cluster.pool.query(`
    INSERT INTO app_feedback (request_id, summary, description, version, build, created_at)
    VALUES (gen_random_uuid(), 'Expired fixture', 'Example', '1.2.3', 'dev', now() - interval '91 days')
  `);
  await cluster.pool.query(`
    INSERT INTO app_feedback (request_id, summary, description, version, build, created_at)
    SELECT gen_random_uuid(), 'Inbox fixture', 'Example', '1.2.3', 'dev', date_trunc('second', now())
    FROM generate_series(1, 26)
  `);
  const first = (await inbox(adminCookie)).json().result.data;
  expect(first.reports).toHaveLength(25);
  const second = (await inbox(adminCookie, first.nextCursor)).json().result.data;
  expect(second.reports).toHaveLength(1);
  expect(second.nextCursor).toBeNull();
  expect(second.reports[0].summary).toBe('Inbox fixture');
  expect(new Set([...first.reports, ...second.reports].map((item) => item.reference)).size).toBe(
    26,
  );
  const freshApp = await buildApp({
    db: cluster.db,
    env: loadEnv({ NODE_ENV: 'test', DATABASE_URL: cluster.connectionString }),
    auth: createAuth(
      cluster.db,
      loadEnv({
        NODE_ENV: 'test',
        DATABASE_URL: cluster.connectionString,
        BETTER_AUTH_SECRET: 'synthetic-fixture-auth-secret',
      }),
    ),
    challonge: fixtureClient([]),
    recomputeTrigger: new RecomputeTrigger(cluster.db),
  });
  try {
    await freshApp.ready();
    expect(
      (
        await cluster.pool.query(
          "SELECT count(*) FROM app_feedback WHERE summary = 'Expired fixture'",
        )
      ).rows[0].count,
    ).toBe('0');
  } finally {
    await freshApp.close();
  }
});
