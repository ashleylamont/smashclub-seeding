import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryStore } from '@rotorsoft/act';
import { eventOperators, user, eventMatches, type Db } from '@smashclub/db';
import { eq } from 'drizzle-orm';
import { createTestDb } from './helpers/testDb';
import { nativeAdmin, seedNativeDraft } from './helpers/nativeLiveFixture';
import { createNativeRuntime, type NativeRuntime } from '../src/tournament/runtime';
import { appRouter } from '../src/trpc/router';
import { loadEnv } from '../src/env';
import { ChallongeClient } from '../src/challonge/client';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { softLockPools } from '../src/event-operations/attendance';
import { reportScore } from '../src/event-operations/service';
import type { HistoryCursor, HistoryEntry } from '../src/tournament/history';

describe('organiser event history', () => {
  let db: Db, close: () => Promise<void>, runtime: NativeRuntime;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    runtime = createNativeRuntime(db, new InMemoryStore());
  });
  afterAll(async () => {
    await runtime.shutdown();
    await close();
  });
  function caller(actor: typeof nativeAdmin | null = nativeAdmin) {
    return appRouter.createCaller({
      db,
      nativeRuntime: runtime,
      user: actor,
      env: loadEnv({ DATABASE_URL: 'pglite://memory', NODE_ENV: 'test' }),
      challonge: new ChallongeClient({}),
      recomputeTrigger: new RecomputeTrigger(db),
    });
  }
  it('restricts reads to admins and TOs assigned to that event, including unpublished events', async () => {
    const planId = await seedNativeDraft(db);
    await runtime.lock(nativeAdmin, planId);
    const to = {
      id: 'history-to',
      name: 'Assigned TO',
      email: 'history-to@example.test',
      role: 'user' as const,
    };
    await db.insert(user).values(to);
    await expect(caller(null).eventOps.live.history({ planId })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(caller(to).eventOps.live.history({ planId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await db.insert(eventOperators).values({ eventPlanId: planId, userId: to.id });
    await runtime.command(nativeAdmin, planId, 'hide-history-event', {
      kind: 'reporting',
      published: false,
      playerReports: false,
      mode: 'to_review',
      expectedRevision: 0,
    });
    expect((await caller(to).eventOps.live.history({ planId })).entries[0]!.title).toBe(
      'Publishing and score reporting changed',
    );
    const other = await seedNativeDraft(db);
    await expect(caller(to).eventOps.live.history({ planId: other })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
  it('pages all recorded events across checkpoints without truncation, duplication or read side effects', async () => {
    const planId = await seedNativeDraft(db);
    expect((await caller().eventOps.live.history({ planId })).entries).toEqual([]);
    await runtime.lock(nativeAdmin, planId);
    for (let i = 0; i < 55; i++) {
      await runtime.command(nativeAdmin, planId, `history-${i}`, {
        kind: 'announce',
        message: `Announcement ${i}`,
        durationSeconds: null,
      });
    }
    await runtime.command(nativeAdmin, planId, 'history-54', {
      kind: 'announce',
      message: 'Announcement 54',
      durationSeconds: null,
    });
    const before = await runtime.state(planId);
    const entries: HistoryEntry[] = [];
    let cursor: HistoryCursor | undefined;
    do {
      const page = await caller().eventOps.live.history({ planId, cursor, limit: 10 });
      expect(page.entries.length).toBeLessThanOrEqual(10);
      entries.push(...page.entries);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(entries).toHaveLength(56);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(56);
    expect(entries[0]).toMatchObject({
      title: 'Announcement posted',
      summary: 'Announcement 54',
      actor: 'TO',
      source: 'operator',
    });
    expect(entries.at(-1)).toMatchObject({
      title: 'Live history started',
      version: 0,
      actor: 'TO',
    });
    expect(entries.slice(0, 55).map((entry) => entry.details)).toEqual(
      Array.from({ length: 55 }, (_, index) =>
        expect.objectContaining({ sequence: before.sequence - index }),
      ),
    );
    expect(
      entries.every((entry, index) => !index || entry.version! < entries[index - 1]!.version!),
    ).toBe(true);
    expect(entries.some((entry) => entry.eventName === '__snapshot__')).toBe(false);
    expect(await runtime.state(planId)).toEqual(before);
    expect(JSON.stringify(entries)).not.toContain('ratingContext');
    expect(JSON.stringify(entries)).not.toContain('receiptKey');
    await expect(caller().eventOps.live.history({ planId, limit: 101 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });
  it('shows guest submissions, TO review and corrections with stable match references without guest credentials', async () => {
    const planId = await seedNativeDraft(db);
    await runtime.lock(nativeAdmin, planId);
    await runtime.command(nativeAdmin, planId, 'review-mode', {
      kind: 'reporting',
      published: true,
      playerReports: true,
      mode: 'to_review',
      expectedRevision: 0,
    });
    const match = (await runtime.state(planId)).matches[0]!;
    const submitted = await runtime.command(
      {
        id: 'guest:private-session-id',
        name: 'Guest',
        role: 'user',
        email: 'guest@example.test',
        guest: true,
      },
      planId,
      'guest-request',
      {
        kind: 'score',
        matchId: match.id,
        expectedRevision: 0,
        score1: 2,
        score2: 1,
        outcome: 'played',
      },
    );
    await runtime.command(nativeAdmin, planId, 'review-guest', {
      kind: 'review',
      reportId: submitted.receipt.reportId!,
      approve: true,
      expectedRevision: 0,
    });
    await runtime.command(nativeAdmin, planId, 'correct-score', {
      kind: 'score',
      matchId: match.id,
      expectedRevision: 1,
      score1: 2,
      score2: 0,
      outcome: 'played',
    });
    const { entries } = await caller().eventOps.live.history({ planId });
    expect(entries.slice(0, 3).map((entry) => [entry.title, entry.source, entry.matchId])).toEqual([
      ['Result corrected', 'operator', match.id],
      ['Score approved', 'operator', match.id],
      ['Score submitted for review', 'guest', match.id],
    ]);
    expect(entries[0]!.summary).toContain('2–0');
    expect(entries[1]!.summary).toContain('2–1');
    expect(JSON.stringify(entries)).not.toContain('private-session-id');
    expect(JSON.stringify(entries)).not.toContain('guest@example.test');
    await runtime.command(nativeAdmin, planId, 'record-forfeit', {
      kind: 'score',
      matchId: match.id,
      expectedRevision: 2,
      score1: null,
      score2: null,
      outcome: 'forfeit',
      winnerId: match.player2Id!,
    });
    expect((await caller().eventOps.live.history({ planId })).entries[0]!.summary).toContain(
      'wins by forfeit',
    );
  });
  it('retains original pre-cutover evidence as imported records without inventing stream events', async () => {
    const planId = await seedNativeDraft(db);
    await softLockPools(db, nativeAdmin, planId);
    const [match] = await db
      .select()
      .from(eventMatches)
      .where(eq(eventMatches.eventPlanId, planId));
    await reportScore(db, nativeAdmin, {
      matchId: match!.id,
      expectedRevision: 0,
      requestId: 'old-score',
      score1: 2,
      score2: 1,
      outcome: 'played',
    });
    await runtime.recover();
    const first = await caller().eventOps.live.history({ planId, limit: 1 });
    expect(first.entries[0]!.title).toBe('Existing event imported');
    expect(first.nextCursor?.source).toBe('imported');
    const entries: HistoryEntry[] = [];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await caller().eventOps.live.history({ planId, cursor, limit: 1 });
      entries.push(...page.entries);
      cursor = page.nextCursor;
    }
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry.source === 'imported' && entry.version === null)).toBe(
      true,
    );
    expect(entries.some((entry) => entry.matchId === match!.id)).toBe(true);
    expect(entries.find((entry) => entry.matchId === match!.id)!.category).toBe('scores');
  });
});
