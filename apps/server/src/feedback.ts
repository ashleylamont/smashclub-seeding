import { appFeedback, type Db } from '@smashclub/db';
import { FEEDBACK_DESCRIPTION_MAX, FEEDBACK_PATH, FEEDBACK_SUMMARY_MAX } from '@smashclub/shared';
import { and, desc, eq, gt, lt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const RETENTION_MS = 90 * DAY_MS;
const PAGE_SIZE = 25;
const MAX_CONCURRENT_SUBMISSIONS = 8;

// PostgreSQL cannot store NUL, and an unpaired surrogate cannot round trip through UTF-8.
const validText = (value: string) => !value.includes('\0') && !/\p{Surrogate}/u.test(value);
const feedbackInput = z.strictObject({
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

async function storeFeedback(db: Db, input: z.infer<typeof feedbackInput>) {
  const { requestId, ...report } = input;
  return db.transaction(async (tx) => {
    // Serialize the count and insert across connections without storing network identifiers.
    await tx.execute(sql`select pg_advisory_xact_lock(782393)`);
    const [existing] = await tx
      .select()
      .from(appFeedback)
      .where(eq(appFeedback.requestId, requestId));
    if (existing) {
      const unchanged =
        existing.summary === report.summary &&
        existing.description === report.description &&
        existing.version === report.version &&
        existing.build === report.build;
      return unchanged ? { created: false, reference: existing.id } : 'conflict';
    }

    const now = Date.now();
    const [volume] = await tx
      .select({
        hour: sql<number>`count(*) filter (where ${appFeedback.createdAt} > ${new Date(now - HOUR_MS).toISOString()}::timestamptz)`.mapWith(
          Number,
        ),
        day: sql<number>`count(*)`.mapWith(Number),
      })
      .from(appFeedback)
      .where(gt(appFeedback.createdAt, new Date(now - DAY_MS)));
    if (volume!.hour >= 60) return 'hour-limit';
    if (volume!.day >= 200) return 'day-limit';

    const [created] = await tx
      .insert(appFeedback)
      .values({ requestId, ...report, createdAt: new Date(now) })
      .returning({ reference: appFeedback.id });
    return { created: true, reference: created!.reference };
  });
}

export function registerFeedbackRoute(app: FastifyInstance, db: Db) {
  let activeSubmissions = 0;
  app.post(
    FEEDBACK_PATH,
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
        return reply.header('Retry-After', '5').code(429).send({ error: 'feedback limit reached' });
      }

      activeSubmissions++;
      try {
        const result = await storeFeedback(db, parsed.data);
        if (result === 'conflict')
          return reply.code(409).send({ error: 'feedback reference in use' });
        if (result === 'hour-limit' || result === 'day-limit') {
          return reply
            .header('Retry-After', result === 'hour-limit' ? '3600' : '86400')
            .code(429)
            .send({ error: 'feedback limit reached' });
        }
        return reply.code(result.created ? 201 : 200).send({
          reference: result.reference,
        });
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
