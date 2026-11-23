import { createHash, createHmac } from 'node:crypto';
import { appFeedback, appFeedbackIssues, type Db } from '@smashclub/db';
import {
  FEEDBACK_DESCRIPTION_MAX,
  FEEDBACK_PATH,
  FEEDBACK_SUMMARY_MAX,
  PUBLIC_FEEDBACK_PATH,
} from '@smashclub/shared';
import { and, desc, eq, gt, isNotNull, lt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { FeedbackPublisher } from './githubFeedback';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const RETENTION_MS = 90 * DAY_MS;
const PAGE_SIZE = 25;
const MAX_CONCURRENT_SUBMISSIONS = 8;
const ADDRESS_WINDOW_MS = 15 * 60_000;
// Give the creating instance its bounded token exchange and issue request first.
const RECHECK_INTERVAL_MS = 10_000;
const MAX_RECHECKS = 5;

// PostgreSQL cannot store NUL, and an unpaired surrogate cannot round trip through UTF-8.
const validText = (value: string) => !value.includes('\0') && !/\p{Surrogate}/u.test(value);
const feedbackInput = z.strictObject({
  publicConsent: z.literal(true),
  requestId: z.uuidv4().transform((id) => id.toLowerCase()),
  summary: z.string().trim().min(1).max(FEEDBACK_SUMMARY_MAX).refine(validText),
  description: z.string().trim().min(1).max(FEEDBACK_DESCRIPTION_MAX).refine(validText),
  version: z
    .string()
    .max(48)
    .regex(/^\d+\.\d+\.\d+(?:-[a-z0-9-]+(?:\.[a-z0-9-]+)*)?(?:\+[a-z0-9-]+(?:\.[a-z0-9-]+)*)?$/i),
  build: z.string().regex(/^(?:dev|[0-9a-f]{7})$/),
});

export const feedbackCursor = z.object({ createdAt: z.iso.datetime(), reference: z.uuidv4() });

export async function listFeedback(db: Db, cursor?: z.infer<typeof feedbackCursor>) {
  const before = cursor
    ? sql`(${appFeedback.createdAt}, ${appFeedback.id}) < (${new Date(cursor.createdAt).toISOString()}::timestamptz, ${cursor.reference}::uuid)`
    : undefined;
  const rows = await db
    .select({
      reference: appFeedback.id,
      summary: appFeedback.summary,
      description: appFeedback.description,
      version: appFeedback.version,
      build: appFeedback.build,
      createdAt: appFeedback.createdAt,
    })
    .from(appFeedback)
    .where(and(gt(appFeedback.createdAt, new Date(Date.now() - RETENTION_MS)), before))
    .orderBy(desc(appFeedback.createdAt), desc(appFeedback.id))
    .limit(PAGE_SIZE + 1);
  const reports = rows
    .slice(0, PAGE_SIZE)
    .map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
  const lastReport = reports.at(-1);
  const nextCursor =
    rows.length > PAGE_SIZE && lastReport
      ? { createdAt: lastReport.createdAt, reference: lastReport.reference }
      : null;
  return { reports, nextCursor };
}

type FeedbackInput = z.infer<typeof feedbackInput>;
type Claim =
  | { status: 'create'; marker: string }
  | { status: 'reconcile'; marker: string; claimedAt: Date; lastCheck: boolean }
  | { status: 'received'; number: number }
  | { status: 'busy'; retryAfter: number }
  | { status: 'conflict' | 'rejected' | 'unavailable' | 'unknown' | 'unresolved' };

async function claimFeedback(
  db: Db,
  input: FeedbackInput,
  rateBucket: string | undefined,
): Promise<Claim> {
  const { requestId, summary, description, version, build } = input;
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([summary, description, version, build]))
    .digest('hex');
  return db.transaction(async (tx) => {
    // Serialize reservation and volume across replicas. The upstream call runs
    // after commit, so a timeout cannot free a claim for duplicate dispatch.
    await tx.execute(sql`select pg_advisory_xact_lock(782394)`);
    const [existing] = await tx
      .select()
      .from(appFeedbackIssues)
      .where(eq(appFeedbackIssues.requestId, requestId));
    const now = new Date();
    if (existing) {
      if (existing.fingerprint !== fingerprint) return { status: 'conflict' };
      if (existing.issueNumber !== null)
        return { status: 'received', number: existing.issueNumber };
      if (existing.rejected) return { status: 'rejected' };
      if (
        existing.checks >= MAX_RECHECKS ||
        now.valueOf() - existing.claimedAt.valueOf() >= DAY_MS
      ) {
        return { status: 'unresolved' };
      }
      if (
        !rateBucket ||
        now.valueOf() - (existing.checkedAt ?? existing.claimedAt).valueOf() < RECHECK_INTERVAL_MS
      )
        return { status: 'unknown' };
      await tx
        .update(appFeedbackIssues)
        .set({ checkedAt: now, checks: existing.checks + 1 })
        .where(eq(appFeedbackIssues.requestId, requestId));
      return {
        status: 'reconcile',
        marker: existing.marker,
        claimedAt: existing.claimedAt,
        lastCheck: existing.checks + 1 >= MAX_RECHECKS,
      };
    }
    if (!rateBucket) return { status: 'unavailable' };

    const since = (window: number) => new Date(now.valueOf() - window).toISOString();
    const [volume] = await tx
      .select({
        address:
          sql<number>`count(*) filter (where ${appFeedbackIssues.rateBucket} = ${rateBucket} and ${appFeedbackIssues.claimedAt} > ${since(ADDRESS_WINDOW_MS)}::timestamptz)`.mapWith(
            Number,
          ),
        hour: sql<number>`count(*) filter (where ${appFeedbackIssues.claimedAt} > ${since(HOUR_MS)}::timestamptz)`.mapWith(
          Number,
        ),
        day: sql<number>`count(*)`.mapWith(Number),
      })
      .from(appFeedbackIssues)
      .where(gt(appFeedbackIssues.claimedAt, new Date(now.valueOf() - DAY_MS)));
    if (volume!.day >= 40) return { status: 'busy', retryAfter: DAY_MS / 1000 };
    if (volume!.hour >= 12) return { status: 'busy', retryAfter: HOUR_MS / 1000 };
    if (volume!.address >= 4) return { status: 'busy', retryAfter: ADDRESS_WINDOW_MS / 1000 };
    const [created] = await tx
      .insert(appFeedbackIssues)
      .values({ requestId, fingerprint, rateBucket, claimedAt: now })
      .returning({ marker: appFeedbackIssues.marker });
    return { status: 'create', marker: created!.marker };
  });
}

export function registerFeedbackRoute(app: FastifyInstance, db: Db, publisher?: FeedbackPublisher) {
  let activeSubmissions = 0;
  app.post(FEEDBACK_PATH, { bodyLimit: 32 * 1024 }, (_request, reply) => {
    // Clients loaded before public consent was introduced must never publish.
    return reply
      .header('Cache-Control', 'no-store')
      .code(410)
      .send({ error: 'private intake retired' });
  });
  app.get(PUBLIC_FEEDBACK_PATH, (_request, reply) =>
    reply.header('Cache-Control', 'no-store').send({ available: Boolean(publisher) }),
  );
  app.post(
    PUBLIC_FEEDBACK_PATH,
    {
      bodyLimit: 32 * 1024,
      onRequest(request, reply, done) {
        reply.header('Cache-Control', 'no-store');
        const { origin, 'sec-fetch-site': site, 'content-type': contentType } = request.headers;
        if (
          origin !== `${request.protocol}://${request.host}` ||
          (site && site !== 'same-origin')
        ) {
          void reply.code(403).send({ error: 'same-origin request required' });
          return;
        }
        if (contentType?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
          void reply.code(415).send({ error: 'JSON required' });
          return;
        }
        done();
      },
      errorHandler(error, _request, reply) {
        if (error.statusCode === 413) {
          void reply.code(413).send({ error: 'feedback too large' });
        } else if (error.statusCode === 400) {
          void reply.code(400).send({ error: 'invalid feedback' });
        } else {
          // Driver and framework errors can contain raw text, parameters or headers.
          app.log.error('Could not accept feedback');
          void reply.code(503).send({ error: 'feedback unavailable' });
        }
      },
    },
    async (request, reply) => {
      const parsed = feedbackInput.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid feedback' });
      if (activeSubmissions >= MAX_CONCURRENT_SUBMISSIONS) {
        return reply.header('Retry-After', '5').code(429).send({ state: 'busy' });
      }

      activeSubmissions++;
      try {
        const rateBucket =
          publisher && createHmac('sha256', publisher.rateKey).update(request.ip).digest('hex');
        const claim = await claimFeedback(db, parsed.data, rateBucket);
        if (claim.status === 'conflict') return reply.code(409).send({ state: 'conflict' });
        if (claim.status === 'received') return reply.code(200).send({ number: claim.number });
        if (claim.status === 'busy') {
          return reply
            .header('Retry-After', String(claim.retryAfter))
            .code(429)
            .send({ state: 'busy' });
        }
        if (claim.status === 'unavailable' || claim.status === 'rejected') {
          return reply.code(503).send({ state: claim.status });
        }
        if (claim.status === 'unresolved') return reply.code(202).send({ state: 'unresolved' });
        if (!publisher || (claim.status !== 'create' && claim.status !== 'reconcile'))
          return reply.code(202).send({ state: 'unknown' });

        const where = eq(appFeedbackIssues.requestId, parsed.data.requestId);
        if (claim.status === 'reconcile') {
          const number = await publisher.find(claim.marker, claim.claimedAt);
          if (number === undefined) {
            return reply.code(202).send({ state: claim.lastCheck ? 'unresolved' : 'unknown' });
          }
          await db.update(appFeedbackIssues).set({ issueNumber: number }).where(where);
          return reply.code(200).send({ number });
        }
        const { summary, description, version, build } = parsed.data;
        const result = await publisher.create({
          summary,
          description,
          version,
          build,
          marker: claim.marker,
        });
        if (result.status === 'unknown') return reply.code(202).send({ state: 'unknown' });
        if (result.status === 'rejected') {
          await db.update(appFeedbackIssues).set({ rejected: true }).where(where);
          return reply.code(503).send({ state: 'rejected' });
        }
        await db.update(appFeedbackIssues).set({ issueNumber: result.number }).where(where);
        return reply.code(201).send({ number: result.number });
      } finally {
        activeSubmissions--;
      }
    },
  );

  const prune = async () => {
    try {
      await db
        .delete(appFeedback)
        .where(lt(appFeedback.createdAt, new Date(Date.now() - RETENTION_MS)));
      await db
        .update(appFeedbackIssues)
        .set({ rateBucket: null })
        .where(
          and(
            isNotNull(appFeedbackIssues.rateBucket),
            lt(appFeedbackIssues.claimedAt, new Date(Date.now() - DAY_MS)),
          ),
        );
    } catch {
      app.log.error('Could not remove expired feedback');
    }
  };
  let cleanup: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  app.addHook('onReady', async () => {
    await prune();
    timer = setInterval(() => {
      cleanup ??= prune().finally(() => {
        cleanup = undefined;
      });
    }, DAY_MS).unref();
  });
  app.addHook('onClose', async () => {
    clearInterval(timer);
    await cleanup;
  });
}
