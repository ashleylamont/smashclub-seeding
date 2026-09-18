import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { eventMatches, eventOperationSettings, eventPlanBrackets, eventPlanEntries, eventPlanPoolPlacements, eventPlans, eventPoolAssignments, players, sets, tournamentParticipants, tournaments, type Db } from '@smashclub/db';
import { createTestDb } from './helpers/testDb';
import { importRegistryPlayers } from '../src/bootstrap/importRegistry';
import { applyHistoricalAdoption, historicalCandidates, previewHistoricalAdoption, type HistoricalAdoptionInput } from '../src/event-planner/historicalAdoption';
import { attachBracket, getPlan, listPlans } from '../src/event-planner/plans';
import { prepare, snapshot } from '../src/event-operations/service';
import { loadEventOverview } from '../src/events/overview';
import { loadRecap } from '../src/recap/recap';
import { eventPlannerRouter } from '../src/trpc/routers/eventPlanner';
import type { TrpcContext } from '../src/trpc/trpc';

let db: Db;
let close: () => Promise<void>;
let input: HistoricalAdoptionInput;
let ids: string[];
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await importRegistryPlayers(db, Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, canonical_name: `Person ${i}`, company: 'X', aliases: [] })));
  ids = (await db.select().from(players).orderBy(asc(players.canonicalName))).map(p => p.id);
  const [plan] = await db.insert(eventPlans).values({ name: 'Historical night', eventDate: new Date('2026-08-25T08:30:00Z'), status: 'complete' }).returning();
  input = { planId: plan!.id, brackets: [] };
  await db.insert(eventPlanEntries).values(ids.slice(0, 8).map((playerId, i) => ({ eventPlanId: input.planId, playerId, sourceLineNumber: i, rawInput: `Person ${i}`, cleanedName: `Person ${i}`, resolutionMethod: 'manual' as const, assignedDivision: i < 4 ? 'upper' as const : 'lower' as const, divisionSeed: i % 4 + 1 })));
  await db.insert(eventPoolAssignments).values(ids.slice(0, 8).map((playerId, i) => ({ eventPlanId: input.planId, playerId, division: i < 4 ? 'upper' as const : 'lower' as const, poolIndex: 0 })));
  await db.insert(eventPlanPoolPlacements).values(ids.slice(0, 8).map((playerId, i) => ({ eventPlanId: input.planId, playerId, division: i < 4 ? 'upper' as const : 'lower' as const, poolIndex: 0, place: i % 4 + 1 })));
  for (const [i, slot] of [{ division: 'upper', stage: 'main' }, { division: 'upper', stage: 'consolation' }, { division: 'lower', stage: 'main' }, { division: 'lower', stage: 'consolation' }].entries()) {
    const [t] = await db.insert(tournaments).values({ challongeSlug: `historic-${i}`, name: `Historical ${slot.division} ${slot.stage}`, eventDate: new Date(`2026-08-25T${String(9 + i).padStart(2, '0')}:00:00Z`), eventDateManual: false, challongeState: 'complete', syncState: 'synced', resultsMode: i % 2 ? 'final_stage_only' : 'auto', raw: { tournamentType: 'single elimination' } }).returning();
    const choice = { division: slot.division as 'upper' | 'lower', stage: slot.stage as 'main' | 'consolation', tournamentId: t!.id };
    input.brackets.push(choice);
    const roster = [0, 4, 2, 3, 1, 5, 6, 8]; // One no-show, one arrival, two division moves.
    const participantRows = await db.insert(tournamentParticipants).values([0, 1].map(n => ({ tournamentId: t!.id, challongeParticipantId: n + 1, playerId: ids[roster[i * 2 + n]!]!, rawName: 'Imported', cleanedName: 'Imported', finalRank: n + 1 }))).returning();
    await db.insert(sets).values({ tournamentId: t!.id, challongeMatchId: 1, p1ParticipantId: participantRows[0]!.id, p2ParticipantId: participantRows[1]!.id, p1PlayerId: participantRows[0]!.playerId, p2PlayerId: participantRows[1]!.playerId, scoresCsv: '2-0', winner: 1, state: 'complete', resultStage: 'final', excludedFromRatings: false });
    await db.insert(eventPlanBrackets).values({ eventPlanId: input.planId, division: choice.division, stage: choice.stage, ...(choice.stage === 'main' ? { tournamentId: t!.id, challongeSlug: t!.challongeSlug, externalState: 'attached' } : {}) });
  }
});
afterEach(async () => close());

async function sourceFacts() {
  return {
    tournaments: await db.select().from(tournaments).orderBy(asc(tournaments.id)),
    participants: await db.select().from(tournamentParticipants).orderBy(asc(tournamentParticipants.id)),
    sets: await db.select().from(sets).orderBy(asc(sets.id)),
    entries: await db.select().from(eventPlanEntries).orderBy(asc(eventPlanEntries.id)),
    pools: await db.select().from(eventPoolAssignments).orderBy(asc(eventPoolAssignments.id)),
    places: await db.select().from(eventPlanPoolPlacements).orderBy(asc(eventPlanPoolPlacements.id)),
  };
}

describe('historical result adoption', () => {
  it('repairs four-bracket membership from every anchor without rewriting imported or planned facts', async () => {
    const before = await sourceFacts();
    const preview = await previewHistoricalAdoption(db, input);
    expect(preview.blocking).toEqual([]);
    expect(preview.differences).toMatchObject({ plannedOnly: [{ playerId: ids[7] }], actualOnly: [{ playerId: ids[8] }] });
    expect(preview.differences.divisionChanges).toHaveLength(2);
    expect((await loadEventOverview(db, 'historic-0'))!.brackets).toHaveLength(2);
    await applyHistoricalAdoption(db, { ...input, fingerprint: preview.fingerprint }, 'admin');
    expect(await sourceFacts()).toEqual(before);
    expect(await db.select().from(eventMatches)).toEqual([]);
    const plan = (await getPlan(db, input.planId))!;
    expect(plan.plan.status).toBe('complete');
    expect(plan.plan.historicalAdoption).toMatchObject({ adoptedBy: 'admin', differences: preview.differences, history: [] });
    for (let i = 0; i < 4; i++) {
      expect((await loadEventOverview(db, `historic-${i}`))!.brackets).toHaveLength(4);
      const recap = await loadRecap(db, `historic-${i}`);
      expect(recap).toBeTruthy();
      expect(JSON.stringify(recap)).toContain('historic-0');
      expect(JSON.stringify(recap)).toContain('historic-3');
    }
    await expect(prepare(db, input.planId)).rejects.toThrow('closed');
    await expect(attachBracket(db, input.planId, 'upper', 'main', 'historic-0')).rejects.toThrow();
  });

  it('publishes a historical result link without presenting archived intent as attendance or confirmed placements', async () => {
    await db.insert(eventOperationSettings).values({ eventPlanId: input.planId, published: true });
    for (const privateView of [false, true]) {
      const normal = await snapshot(db, input.planId, privateView);
      expect(normal.plan.historicalResultsSlug).toBeNull();
      expect(normal.entrants).toHaveLength(8);
      expect(normal.placements).toHaveLength(8);
    }
    const preview = await previewHistoricalAdoption(db, input);
    await applyHistoricalAdoption(db, { ...input, fingerprint: preview.fingerprint }, 'admin');
    for (const privateView of [false, true]) {
      const historical = await snapshot(db, input.planId, privateView);
      expect(historical.plan.historicalResultsSlug).toBe('historic-0');
      expect(historical.entrants).toEqual([]);
      expect(historical.placements).toEqual([]);
    }
    expect((await getPlan(db, input.planId))!.entries).toHaveLength(8);
    expect(await db.select().from(eventPlanPoolPlacements)).toHaveLength(8);
    await db.update(eventOperationSettings).set({ published: false }).where(eq(eventOperationSettings.eventPlanId, input.planId));
    await expect(snapshot(db, input.planId)).rejects.toThrow('not published');
    expect((await snapshot(db, input.planId, true)).plan.historicalResultsSlug).toBe('historic-0');
  });

  it('preserves an audit history when correcting an adopted event', async () => {
    const first = await previewHistoricalAdoption(db, input);
    await applyHistoricalAdoption(db, { ...input, fingerprint: first.fingerprint }, 'first-admin');
    const second = await previewHistoricalAdoption(db, input);
    await applyHistoricalAdoption(db, { ...input, fingerprint: second.fingerprint }, 'second-admin');
    const [plan] = await db.select().from(eventPlans).where(eq(eventPlans.id, input.planId));
    expect(plan!.historicalAdoption!.adoptedBy).toBe('second-admin');
    expect(plan!.historicalAdoption!.history).toHaveLength(1);
    expect(plan!.historicalAdoption!.history[0]!.adoptedBy).toBe('first-admin');
    await expect(applyHistoricalAdoption(db, { ...input, fingerprint: first.fingerprint }, 'admin')).rejects.toThrow('changed');
  });

  it('rejects stale source facts, duplicate selection and cross-plan ownership', async () => {
    const before = await previewHistoricalAdoption(db, input);
    await db.update(sets).set({ scoresCsv: '2-1' }).where(eq(sets.tournamentId, input.brackets[0]!.tournamentId));
    await expect(applyHistoricalAdoption(db, { ...input, fingerprint: before.fingerprint }, 'admin')).rejects.toThrow('changed');
    await expect(previewHistoricalAdoption(db, { ...input, brackets: input.brackets.map(b => ({ ...b, tournamentId: input.brackets[0]!.tournamentId })) })).rejects.toThrow('four different');
    const [other] = await db.insert(eventPlans).values({ name: 'Other event', eventDate: new Date() }).returning();
    await db.insert(eventPlanBrackets).values({ eventPlanId: other!.id, ...input.brackets[1]! });
    const preview = await previewHistoricalAdoption(db, input);
    expect(preview.blocking.join(' ')).toContain('another event plan');
    await expect(applyHistoricalAdoption(db, { ...input, fingerprint: preview.fingerprint }, 'admin')).rejects.toThrow('another event plan');
  });

  it('rejects operational history, unsynced/incomplete imports and cancellation', async () => {
    await db.insert(eventMatches).values({ eventPlanId: input.planId, sourceKey: 'existing', division: 'upper', stage: 'main', label: 'Existing' });
    await db.update(tournaments).set({ syncState: 'error', challongeState: 'underway' }).where(eq(tournaments.id, input.brackets[0]!.tournamentId));
    await db.update(eventPlans).set({ status: 'cancelled' }).where(eq(eventPlans.id, input.planId));
    const preview = await previewHistoricalAdoption(db, input);
    expect(preview.blocking.join(' ')).toContain('operational');
    expect(preview.blocking.join(' ')).toContain('Cancelled');
    expect(preview.blocking.join(' ')).toContain('successfully synced');
    expect(await historicalCandidates(db, input.planId)).toHaveLength(3);
    await expect(applyHistoricalAdoption(db, { ...input, fingerprint: preview.fingerprint }, 'admin')).rejects.toThrow();
  });

  it('keeps unresolved entrants separate and closes an unfinished plan without synthesising play', async () => {
    await db.update(eventPlans).set({ status: 'underway' }).where(eq(eventPlans.id, input.planId));
    const [unresolved] = await db.select().from(tournamentParticipants).where(eq(tournamentParticipants.playerId, ids[8]!));
    await db.update(tournamentParticipants).set({ playerId: null }).where(eq(tournamentParticipants.id, unresolved!.id));
    const preview = await previewHistoricalAdoption(db, input);
    expect(preview.warnings.join(' ')).toContain('unresolved identities');
    expect(preview.differences.actualOnly).toEqual([{ name: 'Imported', playerId: null }]);
    await applyHistoricalAdoption(db, { ...input, fingerprint: preview.fingerprint }, 'admin');
    expect((await getPlan(db, input.planId))!.plan.status).toBe('complete');
    expect(await db.select().from(eventMatches)).toEqual([]);
    expect((await db.select().from(tournamentParticipants).where(eq(tournamentParticipants.id, unresolved!.id)))[0]!.playerId).toBeNull();
  });

  it('requires administrator authentication for every endpoint', async () => {
    for (const user of [null, { id: 'member', role: 'member' }]) {
      const caller = eventPlannerRouter.createCaller({ db, user } as TrpcContext);
      await expect(caller.historicalCandidates({ planId: input.planId })).rejects.toMatchObject({ code: user ? 'FORBIDDEN' : 'UNAUTHORIZED' });
      await expect(caller.previewHistoricalAdoption(input)).rejects.toMatchObject({ code: user ? 'FORBIDDEN' : 'UNAUTHORIZED' });
      await expect(caller.applyHistoricalAdoption({ ...input, fingerprint: 'a'.repeat(64) })).rejects.toMatchObject({ code: user ? 'FORBIDDEN' : 'UNAUTHORIZED' });
    }
  });

  it('counts the saved roster per plan instead of comparing an entry ID to itself', async () => {
    await db.insert(eventPlans).values({ name: 'Empty plan', eventDate: new Date() });
    const plans = await listPlans(db);
    expect(plans.find(p => p.id === input.planId)!.entryCount).toBe(8);
    expect(plans.find(p => p.name === 'Empty plan')!.entryCount).toBe(0);
  });
});
