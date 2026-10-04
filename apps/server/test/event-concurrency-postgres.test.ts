import { afterAll, beforeAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  eventMatchAudit,
  eventMatches,
  eventOperationSettings,
  eventPoolSchedules,
  eventScoreReports,
  eventStations,
} from '@smashclub/db';
import { reportScore, reviewReport, updateMatch } from '../src/event-operations/service';
import { startPoolMatch } from '../src/event-operations/selfService';
import { loadStationQueues } from '../src/event-operations/queue';
import { postgresCluster, contend } from './helpers/postgres';
import { nativeFixture, scoreInput, to, attendee, other } from './helpers/nativeFixture';

let cluster: Awaited<ReturnType<typeof postgresCluster>>;
beforeAll(async () => {
  cluster = await postgresCluster();
});
afterAll(async () => cluster?.close());
const current = async (id: string) =>
  (await cluster.db.select().from(eventMatches).where(eq(eventMatches.id, id)))[0]!;
const audit = (planId: string) =>
  cluster.db.select().from(eventMatchAudit).where(eq(eventMatchAudit.eventPlanId, planId));

it('deduplicates simultaneous retries from the same identity exactly once', async () => {
  const { planId, matches } = await nativeFixture(cluster.db);
  const input = scoreInput(matches[0]!, 'same-request');
  const results = await contend(cluster, planId, [
    () => reportScore(cluster.db, to, input),
    () => reportScore(cluster.db, to, input),
  ]);
  expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
  expect(results[0]).toEqual(results[1]);
  expect(await current(input.matchId)).toMatchObject({
    revision: input.expectedRevision + 1,
    status: 'complete',
  });
  expect(await audit(planId)).toHaveLength(1);
  expect(
    await cluster.db
      .select()
      .from(eventScoreReports)
      .where(eq(eventScoreReports.eventPlanId, planId)),
  ).toHaveLength(1);
  await expect(reportScore(cluster.db, to, { ...input, score2: 0 })).rejects.toMatchObject({
    code: 'CONFLICT',
  });
});

it('accepts one of two conflicting TO reports and rejects the stale revision', async () => {
  const { planId, matches } = await nativeFixture(cluster.db);
  const input = scoreInput(matches[0]!, 'to-first');
  const results = await contend(cluster, planId, [
    () => reportScore(cluster.db, to, input),
    () => reportScore(cluster.db, to, { ...input, requestId: 'to-second', score1: 0, score2: 2 }),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find((r) => r.status === 'rejected')).toMatchObject({
    reason: { code: 'CONFLICT' },
  });
  expect(await audit(planId)).toHaveLength(1);
  const match = await current(input.matchId);
  expect(match.revision).toBe(input.expectedRevision + 1);
  expect([
    [2, 1],
    [0, 2],
  ]).toContainEqual([match.score1, match.score2]);
});

it('simultaneous attendee disagreements keep one result and a durable dispute', async () => {
  const { planId, matches } = await nativeFixture(cluster.db);
  await cluster.db
    .update(eventOperationSettings)
    .set({ scoreReportingMode: 'approve_unless_disputed' })
    .where(eq(eventOperationSettings.eventPlanId, planId));
  const input = scoreInput(matches[0]!, 'attendee-first');
  const results = await contend(cluster, planId, [
    () => reportScore(cluster.db, attendee, input),
    () =>
      reportScore(cluster.db, other, {
        ...input,
        requestId: 'attendee-second',
        score1: 0,
        score2: 2,
      }),
  ]);
  expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
  const reports = await cluster.db
    .select()
    .from(eventScoreReports)
    .where(eq(eventScoreReports.eventPlanId, planId));
  expect(reports.map((r) => r.status).sort()).toEqual(['approved', 'pending']);
  const dispute = reports.find((r) => r.status === 'pending')!;
  expect(dispute.isDispute).toBe(true);
  expect(dispute.userId).not.toBe(reports.find((r) => r.status === 'approved')!.userId);
  expect(await audit(planId)).toHaveLength(1);
  const reviewed = await contend(cluster, planId, [
    () => reviewReport(cluster.db, to, dispute.id, true),
    () => reviewReport(cluster.db, to, dispute.id, false),
  ]);
  expect(reviewed[0]).toEqual(reviewed[1]);
  expect(await audit(planId)).toHaveLength(
    (
      await cluster.db.select().from(eventScoreReports).where(eq(eventScoreReports.id, dispute.id))
    )[0]!.status === 'approved'
      ? 2
      : 1,
  );
});

it('competing attendees cannot start the same queue item twice', async () => {
  const { planId } = await nativeFixture(cluster.db);
  const [station] = await cluster.db
    .insert(eventStations)
    .values({ eventPlanId: planId, name: 'Test station' })
    .returning();
  await cluster.db.insert(eventPoolSchedules).values({
    eventPlanId: planId,
    division: 'upper',
    poolIndex: 0,
    stationIds: [station!.id],
    selfRun: true,
  });
  const queue = (await loadStationQueues(cluster.db, planId)).stationQueues[0]!;
  const match = await current(queue.nextMatchId!);
  const input = {
    planId,
    stationId: station!.id,
    matchId: match.id,
    expectedRevision: match.revision,
  };
  const results = await contend(cluster, planId, [
    () => startPoolMatch(cluster.db, attendee, input),
    () => startPoolMatch(cluster.db, other, input),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find((r) => r.status === 'rejected')).toMatchObject({
    reason: { code: 'CONFLICT' },
  });
  expect(await current(match.id)).toMatchObject({
    status: 'playing',
    stationId: station!.id,
    revision: match.revision + 1,
  });
  expect(await audit(planId)).toHaveLength(1);
});

it('a scheduling hold and score action serialize; a non-operator cannot write controls', async () => {
  const { planId, matches } = await nativeFixture(cluster.db);
  const input = scoreInput(matches[0]!, 'competing-score');
  await expect(
    updateMatch(cluster.db, attendee, {
      matchId: input.matchId,
      expectedRevision: input.expectedRevision,
      status: 'blocked',
    }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  const results = await contend<unknown>(cluster, planId, [
    () => reportScore(cluster.db, to, input),
    () =>
      updateMatch(cluster.db, to, {
        matchId: input.matchId,
        expectedRevision: input.expectedRevision,
        status: 'blocked',
        blockedReason: 'Test hold',
      }),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find((r) => r.status === 'rejected')).toMatchObject({
    reason: { code: 'CONFLICT' },
  });
  expect((await current(input.matchId)).revision).toBe(input.expectedRevision + 1);
});

it('a failed audit insert rolls score, revision and request back; retry then succeeds', async () => {
  const { planId, matches } = await nativeFixture(cluster.db);
  const input = scoreInput(matches[0]!, 'rollback-retry');
  await cluster.pool.query(
    "CREATE FUNCTION fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$; CREATE TRIGGER fail_audit BEFORE INSERT ON event_match_audit FOR EACH ROW EXECUTE FUNCTION fail_audit()",
  );
  try {
    await expect(reportScore(cluster.db, to, input)).rejects.toMatchObject({
      cause: { message: 'synthetic audit failure' },
    });
    expect(await current(input.matchId)).toEqual(matches[0]);
    expect(await audit(planId)).toHaveLength(0);
    expect(
      await cluster.db
        .select()
        .from(eventScoreReports)
        .where(eq(eventScoreReports.eventPlanId, planId)),
    ).toHaveLength(0);
  } finally {
    await cluster.pool.query(
      'DROP TRIGGER fail_audit ON event_match_audit; DROP FUNCTION fail_audit()',
    );
  }
  expect((await reportScore(cluster.db, to, input)).status).toBe('approved');
  expect(await audit(planId)).toHaveLength(1);
});
