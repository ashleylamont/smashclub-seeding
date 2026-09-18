import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { eventMatches, eventOperationSettings, eventPlanEntries, eventPlans, playerClaims, players, ratingEvents, sets, tournaments, user, type Db } from '@smashclub/db';
import type { SessionUser } from '../src/auth';
import { applyAttendance, previewAttendance } from '../src/event-operations/attendance';
import { prepare, reportScore, reviewReport, updateMatch } from '../src/event-operations/service';
import { finalizeNativeEvent, generateNativeBrackets, nativeBracketViews, nativeDraw, previewNativeBrackets, resetNativeBrackets } from '../src/event-operations/nativeBrackets';
import { getPlan, savePoolPlacements } from '../src/event-planner/plans';
import { latestRecomputeId, runRecompute } from '../src/recompute/recompute';
import { loadEventOverview } from '../src/events/overview';
import { createTestDb } from './helpers/testDb';
let db: Db; let close: () => Promise<void>; let planId: string;
const admin: SessionUser = { id: 'admin', role: 'admin', name: 'TO', email: 'to@example.test' };
const member: SessionUser = { id: 'member', role: 'user', name: 'Player', email: 'player@example.test' };
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(user).values([admin, member]);
  const entrants = await db.insert(players).values(Array.from({ length: 14 }, (_, i) => ({ canonicalName: `Entrant ${i}`, displayName: `Alias ${i}` }))).returning();
  planId = (await db.insert(eventPlans).values({ name: 'Native test', eventDate: new Date(), status: 'pools_ready', bracketMode: 'native' }).returning())[0]!.id;
  await db.insert(eventPlanEntries).values(entrants.map((player, i) => ({ eventPlanId: planId, playerId: player.id, sourceLineNumber: i + 1, rawInput: player.canonicalName, cleanedName: player.canonicalName, assignedDivision: i < 7 ? 'upper' as const : 'lower' as const, divisionSeed: i % 7 + 1 })));
  await prepare(db, planId);
});
afterEach(async () => close());
async function score(match: typeof eventMatches.$inferSelect, winner: 1 | 2 = 1) {
  return reportScore(db, admin, { matchId: match.id, expectedRevision: match.revision, requestId: crypto.randomUUID(), score1: winner === 1 ? 2 : 0, score2: winner === 2 ? 2 : 0, outcome: 'played' });
}
async function finishPools() {
  for (const match of await db.select().from(eventMatches)) await score(match);
  const view = (await getPlan(db, planId))!;
  for (const division of view.divisions) await savePoolPlacements(db, planId, division.division, division.pools.map(pool => ({ poolIndex: pool.poolIndex, playerIdsInOrder: pool.members.map(member => member.playerId), expectedMatchRevisions: pool.matchRevisions, expectedPlacementRevision: pool.placementRevision })));
}
async function generate() { const preview = await previewNativeBrackets(db, planId); expect(preview.issues).toEqual([]); await generateNativeBrackets(db, admin, planId, preview.revisionToken); }

describe('native brackets', () => {
  it('draws honest byes and completes all four brackets into history exactly once', async () => {
    expect(nativeDraw(['a', 'b', 'c', 'd', 'e'])).toEqual(['a', null, 'd', 'e', 'b', null, 'c', null]);
    expect(nativeDraw([])).toEqual([]);
    await finishPools(); await generate();
    let rounds = (await db.select().from(eventMatches)).filter(m => m.nativeBracketId);
    expect(rounds.filter(m => m.outcome === 'bye')).toHaveLength(2);
    expect(rounds.filter(m => m.outcome === 'bye').every(m => m.score1 === null && m.score2 === null && m.winnerId !== null)).toBe(true);
    while (rounds.some(m => m.status === 'ready')) {
      for (const match of rounds.filter(m => m.status === 'ready')) await score(match);
      rounds = (await db.select().from(eventMatches)).filter(m => m.nativeBracketId);
    }
    expect((await nativeBracketViews(db, planId)).every(b => b.complete && b.standings.length === b.entrantIds.length)).toBe(true);
    await finalizeNativeEvent(db, admin, planId);
    const imported = await db.select().from(sets);
    expect(imported).toHaveLength(30);
    expect(imported.filter(set => !set.excludedFromRatings)).toHaveLength(28);
    expect(imported.filter(set => set.resultStage === 'group')).toHaveLength(18);
    expect((await db.select().from(tournaments)).every(t => t.provider === 'native' && t.challongeState === 'complete')).toBe(true);
    expect((await finalizeNativeEvent(db, admin, planId)).alreadyFinalized).toBe(true);
    expect(await db.select().from(sets)).toHaveLength(30);
    await runRecompute(db);
    const recomputeId = await latestRecomputeId(db);
    expect((await db.select().from(ratingEvents).where(eq(ratingEvents.recomputeId, recomputeId!))).filter(event => !event.isDecay)).toHaveLength(56);
    const [published] = await db.select().from(tournaments);
    const overview = (await loadEventOverview(db, published!.challongeSlug))!;
    expect(overview.brackets).toHaveLength(4);
    expect(overview.divisions.every(division => division.players.length === 7 && division.players.every(player => player.place !== null))).toBe(true);
    await expect(score(rounds[0]!)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('uses preview revisions, only rebuilds unplayed draws, and protects downstream play', async () => {
    await finishPools();
    const stale = await previewNativeBrackets(db, planId);
    await score((await db.select().from(eventMatches))[0]!);
    await expect(generateNativeBrackets(db, admin, planId, stale.revisionToken)).rejects.toThrow(/changed/);
    await generate();
    const draw = await previewNativeBrackets(db, planId);
    await resetNativeBrackets(db, admin, planId, draw.revisionToken);
    expect(await nativeBracketViews(db, planId)).toHaveLength(0);
    await generate();
    const semifinal = (await db.select().from(eventMatches)).find(m => m.nativeBracketId && m.division === 'upper' && m.stage === 'main' && m.nativeRound === 1)!;
    await score(semifinal);
    let refreshed = (await db.select().from(eventMatches).where(eq(eventMatches.id, semifinal.id)))[0]!;
    await score(refreshed, 2);
    const other = (await db.select().from(eventMatches)).find(m => m.nativeBracketId === semifinal.nativeBracketId && m.nativeRound === 1 && m.id !== semifinal.id)!;
    await score(other);
    const final = (await db.select().from(eventMatches)).find(m => m.nativeBracketId === semifinal.nativeBracketId && m.nativeRound === 2)!;
    expect([final.player1Id, final.player2Id]).toContain(semifinal.player2Id);
    await updateMatch(db, admin, { matchId: final.id, expectedRevision: final.revision, status: 'playing' });
    refreshed = (await db.select().from(eventMatches).where(eq(eventMatches.id, semifinal.id)))[0]!;
    await expect(score(refreshed)).rejects.toThrow(/downstream/);
    const playingFinal = (await db.select().from(eventMatches).where(eq(eventMatches.id, final.id)))[0]!;
    await updateMatch(db, admin, { matchId: final.id, expectedRevision: playingFinal.revision, status: 'ready' });
    await expect(score(refreshed)).rejects.toThrow(/downstream/);
    const preview = await previewNativeBrackets(db, planId);
    expect(preview.allowed).toBe(false);
    await expect(resetNativeBrackets(db, admin, planId, preview.revisionToken)).rejects.toThrow(/started/);
  });

  it('resolves withdrawn branches without inventing games or a champion', async () => {
    await finishPools(); await generate();
    const withdraw = async (playerId: string) => {
      const input = { planId, action: 'withdraw' as const, playerId };
      const preview = await previewAttendance(db, input);
      expect(preview.issues).toEqual([]);
      await applyAttendance(db, admin, { ...input, revisionToken: preview.revisionToken });
    };
    const semis = (await db.select().from(eventMatches)).filter(m => m.nativeBracketId && m.division === 'upper' && m.stage === 'main' && m.nativeRound === 1);
    await withdraw(semis[0]!.player1Id!); await withdraw(semis[0]!.player2Id!);
    await score(semis[1]!);
    let upper = (await nativeBracketViews(db, planId)).find(b => b.division === 'upper' && b.stage === 'main')!;
    expect(upper.complete).toBe(true);
    expect(upper.winnerId).toBe(semis[1]!.player1Id);
    const final = (await db.select().from(eventMatches)).find(m => m.nativeBracketId === upper.id && m.nativeRound === 2)!;
    expect(final.outcome).toBe('bye'); expect(final.score1).toBeNull();
    const lowerSemis = (await db.select().from(eventMatches)).filter(m => m.nativeBracketId && m.division === 'lower' && m.stage === 'main' && m.nativeRound === 1);
    for (const match of lowerSemis) await score(match);
    const lowerFinal = (await db.select().from(eventMatches)).find(m => m.nativeBracketId === lowerSemis[0]!.nativeBracketId && m.nativeRound === 2)!;
    await withdraw(lowerFinal.player1Id!); await withdraw(lowerFinal.player2Id!);
    const lower = (await nativeBracketViews(db, planId)).find(b => b.division === 'lower' && b.stage === 'main')!;
    expect(lower.complete).toBe(true); expect(lower.winnerId).toBeNull();
    expect(lower.standings.some(p => p.place === 1)).toBe(false);
  });

  it('closes a vacant final when its sole qualifier has withdrawn', async () => {
    await finishPools(); await generate();
    const semis = (await db.select().from(eventMatches)).filter(m => m.nativeBracketId && m.division === 'upper' && m.stage === 'main' && m.nativeRound === 1);
    await score(semis[0]!);
    for (const playerId of [semis[0]!.player1Id!, semis[1]!.player1Id!, semis[1]!.player2Id!]) {
      const input = { planId, action: 'withdraw' as const, playerId };
      const preview = await previewAttendance(db, input);
      await applyAttendance(db, admin, { ...input, revisionToken: preview.revisionToken });
    }
    const bracket = (await nativeBracketViews(db, planId)).find(b => b.id === semis[0]!.nativeBracketId)!;
    expect(bracket.complete).toBe(true); expect(bracket.winnerId).toBeNull();
  });

  it('advances only after a player report is approved', async () => {
    await finishPools(); await generate();
    const match = (await db.select().from(eventMatches)).find(m => m.nativeBracketId && m.stage === 'main' && m.status === 'ready')!;
    await db.update(eventOperationSettings).set({ playerReports: true, published: true }).where(eq(eventOperationSettings.eventPlanId, planId));
    await db.insert(playerClaims).values({ userId: member.id, playerId: match.player1Id!, status: 'approved' });
    const report = await reportScore(db, member, { matchId: match.id, expectedRevision: match.revision, requestId: 'player-final', score1: 2, score2: 1, outcome: 'played' });
    expect((await db.select().from(eventMatches).where(eq(eventMatches.id, match.id)))[0]!.status).toBe('ready');
    await reviewReport(db, admin, report.id, true);
    const downstream = (await db.select().from(eventMatches)).find(m => m.parent1MatchId === match.id || m.parent2MatchId === match.id)!;
    expect([downstream.player1Id, downstream.player2Id]).toContain(match.player1Id);
  });
});
