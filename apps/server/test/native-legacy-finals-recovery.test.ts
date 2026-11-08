import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { InMemoryStore } from '@rotorsoft/act';
import { eventMatches, eventNativeBrackets, nativeLiveHandoffs, type Db } from '@smashclub/db';
import {
  generateNativeBrackets,
  previewNativeBrackets,
} from '../src/event-operations/nativeBrackets';
import { prepare } from '../src/event-operations/service';
import { createNativeRuntime } from '../src/tournament/runtime';
import { nativeAdmin, seedNativeDraft } from './helpers/nativeLiveFixture';
import { createTestDb } from './helpers/testDb';
import { placementInput, scoreActMatch } from './helpers/nativeLegacyFinalsFixture';

it('recovers legacy finals before their pool places are confirmed', async () => {
  const { db, close } = await createTestDb();
  const runtime = createNativeRuntime(db, new InMemoryStore());
  try {
    const planId = await drawPendingLegacyFinals(db);
    const brackets = await db
      .select()
      .from(eventNativeBrackets)
      .where(eq(eventNativeBrackets.eventPlanId, planId));
    expect(brackets).toHaveLength(4);
    expect(brackets[0]!.entrantIds[0]).toMatch(/^pending:(upper|lower):\d+:\d+$/);
    const matches = await db
      .select()
      .from(eventMatches)
      .where(eq(eventMatches.eventPlanId, planId));

    await runtime.recover();
    const recovered = await runtime.state(planId);
    expect(recovered.brackets.map(({ id }) => id).sort()).toEqual(
      brackets.map(({ id }) => id).sort(),
    );
    expect(recovered.matches.map(({ id }) => id).sort()).toEqual(
      matches.map(({ id }) => id).sort(),
    );
    expect(recovered.matches.every(({ outcome }) => outcome === null)).toBe(true);
    expect(await runtime.replay(planId)).toEqual(recovered);
    expect(
      await db.select().from(nativeLiveHandoffs).where(eq(nativeLiveHandoffs.eventPlanId, planId)),
    ).toHaveLength(1);

    const upper = recovered.pools.filter((pool) => pool.division === 'upper');
    for (const match of recovered.matches.filter((m) => upper.some((p) => p.id === m.poolId)))
      await scoreActMatch(runtime, planId, match);
    const before = await runtime.state(planId);
    const pairing = before.matches.find(
      (m) => m.division === 'upper' && m.player1Qualifier && m.player2Qualifier,
    )!;
    expect(pairing).toBeDefined();
    await runtime.command(nativeAdmin, planId, crypto.randomUUID(), {
      kind: 'poolOrders',
      pools: upper.map((pool) => placementInput(before, pool.id)),
    });
    const after = await runtime.state(planId);
    expect(after.matches.find((m) => m.id === pairing.id)).toMatchObject({
      revision: pairing.revision + 1,
      status: 'ready',
      player1Qualifier: { status: 'resolved' },
      player2Qualifier: { status: 'resolved' },
    });
    const lower = after.pools.find((pool) => pool.division === 'lower')!;
    for (const match of after.matches.filter((m) => m.poolId === lower.id))
      await scoreActMatch(runtime, planId, match);
    const beforeSingle = await runtime.state(planId);
    await runtime.command(nativeAdmin, planId, crypto.randomUUID(), {
      kind: 'placements',
      ...placementInput(beforeSingle, lower.id),
    });
    const afterSingle = await runtime.state(planId);
    expect(afterSingle.pools.find(({ id }) => id === lower.id)?.order).toEqual(lower.entrantIds);
    expect(
      afterSingle.matches.some((m) => m.qualificationBlocks?.some((q) => q.poolId === lower.id)),
    ).toBe(false);
    expect(
      afterSingle.matches.some((m) => m.division === 'lower' && m.qualificationBlocks?.length),
    ).toBe(true);
    expect(await runtime.replay(planId)).toEqual(afterSingle);
  } finally {
    await runtime.shutdown();
    await close();
  }
});

it.each([
  ['invalid place', 'invalid or duplicate qualifier'],
  ['duplicate source', 'invalid or duplicate qualifier'],
  ['cross-bracket feeder', 'invalid match positions or feeders'],
  ['dangling feeder', 'invalid match positions or feeders'],
  ['started side', 'recorded play or report history'],
] as const)('refuses a legacy draw with %s without taking ownership', async (problem, message) => {
  const { db, close } = await createTestDb();
  const runtime = createNativeRuntime(db, new InMemoryStore());
  try {
    const planId = await drawPendingLegacyFinals(db);
    const brackets = await db
      .select()
      .from(eventNativeBrackets)
      .where(eq(eventNativeBrackets.eventPlanId, planId));
    const main = brackets.find(({ division, stage }) => division === 'upper' && stage === 'main')!;
    const consolation = brackets.find(
      ({ division, stage }) => division === 'upper' && stage === 'consolation',
    )!;
    if (problem === 'invalid place' || problem === 'duplicate source') {
      const seeds = main.entrantIds.with(
        0,
        problem === 'invalid place' ? 'pending:upper:0:0' : consolation.entrantIds[0]!,
      );
      await db
        .update(eventNativeBrackets)
        .set({ entrantIds: seeds })
        .where(eq(eventNativeBrackets.id, main.id));
    } else {
      const matches = await db
        .select()
        .from(eventMatches)
        .where(eq(eventMatches.eventPlanId, planId));
      const first = matches.find((m) => m.nativeBracketId === main.id && m.nativeRound === 1)!;
      const later = matches.find((m) => m.nativeBracketId === main.id && m.nativeRound === 2)!;
      const foreign = matches.find(
        (m) => m.nativeBracketId === consolation.id && m.nativeRound === 1,
      )!;
      if (problem === 'cross-bracket feeder' || problem === 'dangling feeder')
        await db
          .update(eventMatches)
          .set({ parent1MatchId: problem === 'cross-bracket feeder' ? foreign.id : null })
          .where(eq(eventMatches.id, later.id));
      else
        await db
          .update(eventMatches)
          .set({ status: 'playing' })
          .where(eq(eventMatches.id, first.id));
    }
    await expect(runtime.recover()).rejects.toThrow(message);
    expect(
      await db.select().from(nativeLiveHandoffs).where(eq(nativeLiveHandoffs.eventPlanId, planId)),
    ).toEqual([]);
  } finally {
    await runtime.shutdown();
    await close();
  }
});

async function drawPendingLegacyFinals(db: Db) {
  const planId = await seedNativeDraft(db);
  await prepare(db, planId);
  const preview = await previewNativeBrackets(db, planId);
  await generateNativeBrackets(db, nativeAdmin, planId, preview.revisionToken);
  return planId;
}
