import { randomUUID } from 'node:crypto';
import type { Db } from '@smashclub/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createAuth } from '../src/auth';
import { loadEnv } from '../src/env';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { fixtureClient } from './helpers/challongeFixtures';
import { createTestDb } from './helpers/testDb';

const origin = 'http://localhost:5173';
const path = '/api/feedback/public';
let app: FastifyInstance;
let testDb: Db;
let closeDb: () => Promise<void>;
beforeAll(async () => {
  const { db, close } = await createTestDb();
  testDb = db;
  closeDb = close;
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'pglite://memory',
    BETTER_AUTH_SECRET: 'synthetic-test-feedback-secret',
    BETTER_AUTH_URL: origin,
  });
  app = await buildApp({
    db,
    env,
    auth: createAuth(db, env),
    challonge: fixtureClient([]),
    recomputeTrigger: new RecomputeTrigger(db),
  });
});
afterAll(async () => {
  await app?.close();
  await closeDb?.();
});

it('stops accepting private submissions from old clients', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/feedback',
    headers: { host: 'localhost:5173', origin, 'content-type': 'application/json' },
    payload: {
      requestId: randomUUID(),
      summary: 'An old private draft',
      description: 'The reporter previously expected this to remain private.',
      version: '1.2.3',
      build: 'dev',
    },
  });
  expect(response.statusCode).toBe(410);
});

it('reports unavailable when the GitHub publisher is unconfigured', async () => {
  const response = await app.inject({ method: 'GET', url: path });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ available: false });
  expect(response.headers['cache-control']).toBe('no-store');
});

it('rejects a public submission without storing it when GitHub is unconfigured', async () => {
  const response = await app.inject({
    method: 'POST',
    url: path,
    headers: { host: 'localhost:5173', origin, 'content-type': 'application/json' },
    payload: {
      publicConsent: true,
      requestId: randomUUID(),
      summary: 'A reviewed public report',
      description: 'Nobody should receive this from a server without a publisher.',
      version: '1.2.3',
      build: 'dev',
    },
  });
  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({ state: 'unavailable' });
});

it('keeps the app healthy with malformed optional feedback settings', async () => {
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'pglite://memory',
    BETTER_AUTH_SECRET: 'synthetic-test-feedback-secret',
    BETTER_AUTH_URL: origin,
    FEEDBACK_GITHUB_APP_ID: 'not-an-app-id',
  });
  const malformed = await buildApp({
    db: testDb,
    env,
    auth: createAuth(testDb, env),
    challonge: fixtureClient([]),
    recomputeTrigger: new RecomputeTrigger(testDb),
  });
  try {
    expect((await malformed.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    expect((await malformed.inject({ method: 'GET', url: path })).json()).toEqual({
      available: false,
    });
  } finally {
    await malformed.close();
  }
});
