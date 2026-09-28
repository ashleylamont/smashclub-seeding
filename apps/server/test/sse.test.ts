import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import type { Db } from '@smashclub/db';
import { buildApp } from '../src/app';
import { createAuth } from '../src/auth';
import { loadEnv } from '../src/env';
import { liveBus } from '../src/live/bus';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { createTestDb } from './helpers/testDb';
import { fixtureClient } from './helpers/challongeFixtures';

/**
 * The live feeds are public and long-lived, so admission control is the only
 * thing bounding what an anonymous client can make the process hold. These
 * tests run against a real listening socket — `inject` does not model a client
 * that connects and then simply never leaves.
 */

let db: Db;
let close: () => Promise<void>;
let app: FastifyInstance;
let baseUrl: string;

const MAX_CONNECTIONS = 3;
const MAX_PER_IP = 2;
const MAX_STREAM_MS = 300;

/** Open streams currently subscribed to the process-global bus. */
function busListeners(): number {
  return liveBus.listenerCount('event');
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Open a live stream, leaving the body unread the way an idle tab would. */
async function openStream(path = '/api/live'): Promise<{ response: Response; abort: () => void }> {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}${path}`, { signal: controller.signal });
  return { response, abort: () => controller.abort() };
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://unused',
    BETTER_AUTH_SECRET: 'test-secret-test-secret-test',
    SSE_MAX_CONNECTIONS: String(MAX_CONNECTIONS),
    SSE_MAX_CONNECTIONS_PER_IP: String(MAX_PER_IP),
    SSE_MAX_STREAM_MS: String(MAX_STREAM_MS),
  });
  app = await buildApp({
    db,
    env,
    auth: createAuth(db, env),
    challonge: fixtureClient([]),
    recomputeTrigger: new RecomputeTrigger(db),
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await app.close();
  await close();
});

describe('SSE admission control', () => {
  it('rejects streams past the per-client cap without allocating anything', async () => {
    const streams = [await openStream(), await openStream()];
    for (const stream of streams) expect(stream.response.status).toBe(200);
    await waitFor(() => busListeners() === MAX_PER_IP);

    const refused = await fetch(`${baseUrl}/api/live`);
    expect(refused.status).toBe(503);
    expect(refused.headers.get('retry-after')).toBe('30');
    await refused.text();
    // The refusal is a refusal: no listener, no timer, no socket retained.
    expect(busListeners()).toBe(MAX_PER_IP);

    for (const stream of streams) stream.abort();
    await waitFor(() => busListeners() === 0);
  });

  it('frees the slot when a client disconnects', async () => {
    const first = await openStream();
    const second = await openStream();
    expect(second.response.status).toBe(200);
    await waitFor(() => busListeners() === 2);

    first.abort();
    await waitFor(() => busListeners() === 1);

    const third = await openStream();
    expect(third.response.status).toBe(200);
    await waitFor(() => busListeners() === 2);

    second.abort();
    third.abort();
    await waitFor(() => busListeners() === 0);
  });

  it('closes a stream that outlives the maximum lifetime', async () => {
    const stream = await openStream();
    expect(stream.response.status).toBe(200);
    await waitFor(() => busListeners() === 1);

    // Nothing is aborted here: the server must hang up on its own.
    await waitFor(() => busListeners() === 0);
    expect(busListeners()).toBe(0);
  });

  it('counts per-tournament streams against the same caps', async () => {
    const streams = [await openStream('/api/live/abc'), await openStream('/api/live/def')];
    for (const stream of streams) expect(stream.response.status).toBe(200);
    await waitFor(() => liveBus.listenerCount('tournament:abc') === 1);

    const refused = await fetch(`${baseUrl}/api/live`);
    expect(refused.status).toBe(503);
    await refused.text();

    for (const stream of streams) stream.abort();
    await waitFor(() => liveBus.listenerCount('tournament:abc') === 0);
  });
});
