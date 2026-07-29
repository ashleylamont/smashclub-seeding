import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { sql } from 'drizzle-orm';
import type { Db } from '@smashclub/db';
import type { Auth } from './auth';
import { getSessionUser } from './auth';
import type { ChallongeClient } from './challonge/client';
import type { Env } from './env';
import { liveBus, type LiveEvent } from './live/bus';
import type { RecomputeTrigger } from './recompute/trigger';
import { appRouter } from './trpc/router';
import type { TrpcContext } from './trpc/trpc';

export interface AppDeps {
  db: Db;
  env: Env;
  auth: Auth;
  challonge: ChallongeClient;
  recomputeTrigger: RecomputeTrigger;
}

const SSE_HEARTBEAT_MS = 25_000;

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { db, env, auth, challonge, recomputeTrigger } = deps;
  const app = Fastify({ logger: env.NODE_ENV !== 'test' });

  app.get('/healthz', async () => {
    await db.execute(sql`select 1`);
    return { ok: true };
  });

  // --- better-auth (fetch-style handler bridged onto Fastify) ---
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    handler: async (request, reply) => {
      const response = await auth.handler(toWebRequest(request));
      reply.status(response.status);
      response.headers.forEach((value, key) => {
        reply.header(key, value);
      });
      reply.send(response.body ? Buffer.from(await response.arrayBuffer()) : null);
    },
  });

  // --- tRPC ---
  await app.register(fastifyTRPCPlugin, {
    prefix: '/api/trpc',
    trpcOptions: {
      router: appRouter,
      createContext: async ({ req }: { req: FastifyRequest }): Promise<TrpcContext> => {
        const user = await getSessionUser(auth, db, env, toWebHeaders(req));
        return { db, env, user, challonge, recomputeTrigger };
      },
    },
  });

  // --- SSE live feeds ---
  app.get('/api/live', (request, reply) => startSse(request, reply));
  app.get<{ Params: { tournamentId: string } }>('/api/live/:tournamentId', (request, reply) =>
    startSse(request, reply, request.params.tournamentId),
  );

  // --- static SPA (production) ---
  if (env.WEB_DIST_DIR) {
    await app.register(fastifyStatic, { root: path.resolve(env.WEB_DIST_DIR), wildcard: true });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        void reply.status(404).send({ error: 'not found' });
        return;
      }
      void reply.sendFile('index.html');
    });
  }

  return app;
}

function startSse(request: FastifyRequest, reply: FastifyReply, tournamentId?: string): void {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  reply.raw.write(': connected\n\n');

  const send = (event: LiveEvent): void => {
    reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event.payload ?? {})}\n\n`);
  };
  const unsubscribe = liveBus.subscribe(send, tournamentId);
  const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), SSE_HEARTBEAT_MS);

  request.raw.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

function toWebHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers.append(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  return headers;
}

function toWebRequest(request: FastifyRequest): Request {
  const url = `${request.protocol}://${request.headers.host ?? 'localhost'}${request.url}`;
  const init: RequestInit = { method: request.method, headers: toWebHeaders(request) };
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.body !== undefined && request.body !== null) {
    init.body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
  }
  return new Request(url, init);
}
