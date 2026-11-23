import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppDeps } from '../src/app';
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
let publisher: NonNullable<AppDeps['feedbackPublisher']>;
let posted: Parameters<typeof publisher.create>[0][];
let createResult: Awaited<ReturnType<typeof publisher.create>>;
let recoveredIssue: number | undefined;
let lookups: number;
let holdCreate: Promise<void> | undefined;
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
  publisher = {
    rateKey: 'synthetic-feedback-rate-key',
    async create(input) {
      posted.push(input);
      await holdCreate;
      return createResult;
    },
    async find() {
      lookups++;
      return recoveredIssue;
    },
  };
  const createApp = (db: typeof cluster.db) =>
    buildApp({
      db,
      env,
      auth: createAuth(db, env, { enableCredentials: true }),
      challonge: fixtureClient([]),
      recomputeTrigger: new RecomputeTrigger(db),
      feedbackPublisher: publisher,
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
  await cluster.pool.query('TRUNCATE app_feedback, app_feedback_issues');
  posted = [];
  createResult = { status: 'created', number: 123 };
  recoveredIssue = undefined;
  lookups = 0;
  holdCreate = undefined;
});

afterAll(async () => {
  await Promise.all([app?.close(), secondApp?.close()]);
  await secondConnection?.pool.end();
  await cluster?.close();
});

function report() {
  return {
    requestId: randomUUID(),
    publicConsent: true,
    summary: ' Synthetic report ',
    description: ' Example steps to reproduce\nMade up for the test. ',
    version: '1.2.3',
    build: '1a2b3c4',
  };
}

function send(
  payload: object | string,
  target = app,
  headers: Record<string, string> = {},
  remoteAddress = '192.0.2.1',
) {
  return target.inject({
    method: 'POST',
    url: '/api/feedback/public',
    remoteAddress,
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

it('claims a signed-out public report across replicas and recovers its receipt', async () => {
  const payload = report();
  const legacy = await app.inject({ method: 'POST', url: '/api/feedback', payload });
  expect(legacy.statusCode).toBe(410);
  expect(posted).toHaveLength(0);
  let release!: () => void;
  holdCreate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const creating = send(payload, app, {
    cookie: memberCookie,
    referer: `${origin}/private?guest=example`,
  });
  try {
    await expect.poll(() => posted.length).toBe(1);
    const concurrent = await send(payload, secondApp);
    expect(concurrent.statusCode).toBe(202);
    expect(concurrent.json()).toEqual({ state: 'unknown' });
  } finally {
    release();
  }
  const receipt = { number: 123 };
  const created = await creating;
  expect(created.statusCode).toBe(201);
  expect(created.json()).toEqual(receipt);
  expect((await send(payload, secondApp)).json()).toEqual(receipt);
  expect((await send({ ...payload, summary: 'Edited text' })).statusCode).toBe(409);
  expect(posted).toEqual([
    {
      summary: payload.summary.trim(),
      description: payload.description.trim(),
      version: payload.version,
      build: payload.build,
      marker: expect.stringMatching(/^[0-9a-f-]{36}$/),
    },
  ]);
  expect(posted[0]?.marker).not.toBe(payload.requestId);
  expect((await cluster.pool.query('SELECT count(*) FROM app_feedback')).rows[0].count).toBe('0');
  const stored = (await cluster.pool.query('SELECT * FROM app_feedback_issues')).rows[0];
  expect(JSON.stringify(stored)).not.toContain(payload.description.trim());
  expect(JSON.stringify(stored)).not.toContain('192.0.2.1');
  expect((await inbox()).statusCode).toBe(401);
  expect((await inbox(memberCookie)).statusCode).toBe(403);
  const admin = await inbox(adminCookie);
  expect(admin.headers['cache-control']).toBe('no-store');
  expect(admin.json().result.data.reports).toEqual([]);
});

it('checks an uncertain upload before returning a receipt and never submits it twice', async () => {
  const payload = report();
  createResult = { status: 'unknown' };
  expect((await send(payload)).statusCode).toBe(202);
  expect((await send(payload, secondApp)).statusCode).toBe(202);
  await cluster.pool.query(
    "UPDATE app_feedback_issues SET claimed_at = now() - interval '1 minute'",
  );
  expect((await send(payload, secondApp)).statusCode).toBe(202);
  await cluster.pool.query(
    "UPDATE app_feedback_issues SET checked_at = now() - interval '1 minute'",
  );
  recoveredIssue = 357;
  const recovered = await send(payload, secondApp);
  expect(recovered.statusCode).toBe(200);
  expect(recovered.json()).toEqual({ number: 357 });
  expect((await send(payload)).json()).toEqual({ number: 357 });
  expect(posted).toHaveLength(1);
});

it('bounds GitHub lookups per unresolved receipt and retires lookups after a day', async () => {
  const payload = report();
  createResult = { status: 'unknown' };
  expect((await send(payload)).statusCode).toBe(202);
  await cluster.pool.query(
    "UPDATE app_feedback_issues SET claimed_at = now() - interval '1 minute'",
  );
  for (let index = 0; index < 6; index++) {
    await cluster.pool.query(
      "UPDATE app_feedback_issues SET checked_at = now() - interval '1 minute'",
    );
    expect((await send(payload, secondApp)).statusCode).toBe(202);
  }
  expect(lookups).toBe(5);
  expect((await send(payload, secondApp)).json()).toEqual({ state: 'unresolved' });

  const expired = report();
  expect((await send(expired)).statusCode).toBe(202);
  await cluster.pool.query(
    "UPDATE app_feedback_issues SET claimed_at = now() - interval '25 hours' WHERE request_id = $1",
    [expired.requestId],
  );
  expect((await send(expired, secondApp)).json()).toEqual({ state: 'unresolved' });
  expect(lookups).toBe(5);
  expect(posted).toHaveLength(2);
});

it('allows a new attempt after a definite rejection without reusing the earlier request', async () => {
  const rejected = report();
  createResult = { status: 'rejected' };
  expect((await send(rejected)).statusCode).toBe(503);
  expect((await send(rejected, secondApp)).statusCode).toBe(503);
  expect(posted).toHaveLength(1);
  createResult = { status: 'created', number: 456 };
  expect((await send({ ...rejected, requestId: randomUUID() })).json()).toEqual({ number: 456 });
  expect(posted).toHaveLength(2);
});

it('rejects extra metadata, invalid builds, cross-origin and malformed or oversized submissions', async () => {
  const badRequests = await Promise.all([
    send({ ...report(), publicConsent: false }),
    send({ ...report(), publicConsent: undefined }),
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
    400, 400, 400, 400, 400, 400, 400, 400, 400, 413, 415, 403, 403, 403, 403,
  ]);
  expect(posted).toHaveLength(0);
});

it('limits anonymous submissions from one address without blocking a recovered receipt', async () => {
  const first = report();
  expect((await send(first)).statusCode).toBe(201);
  for (let index = 0; index < 3; index++) {
    expect((await send(report(), secondApp)).statusCode).toBe(201);
  }
  expect((await send(report())).statusCode).toBe(429);
  expect((await send(first, secondApp)).statusCode).toBe(200);
  expect((await send(report(), app, {}, '192.0.2.2')).statusCode).toBe(201);
});

it('limits rolling repository volume across connections and addresses', async () => {
  await cluster.pool.query(`
    INSERT INTO app_feedback_issues (request_id, fingerprint)
    SELECT gen_random_uuid(), 'synthetic' FROM generate_series(1, 11)
  `);
  const concurrent = await Promise.all([send(report()), send(report(), secondApp)]);
  expect(concurrent.map((response) => response.statusCode).sort()).toEqual([201, 429]);
  expect(concurrent.find((response) => response.statusCode === 429)?.headers['retry-after']).toBe(
    '3600',
  );

  await cluster.pool.query(
    "UPDATE app_feedback_issues SET claimed_at = now() - interval '2 hours'",
  );
  await cluster.pool.query(`
    INSERT INTO app_feedback_issues (request_id, fingerprint, claimed_at)
    SELECT gen_random_uuid(), 'synthetic', now() - interval '2 hours' FROM generate_series(1, 28)
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
    env: loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: cluster.connectionString,
      BETTER_AUTH_URL: origin,
    }),
    auth: createAuth(
      cluster.db,
      loadEnv({
        NODE_ENV: 'test',
        DATABASE_URL: cluster.connectionString,
        BETTER_AUTH_SECRET: 'synthetic-fixture-auth-secret',
        BETTER_AUTH_URL: origin,
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
