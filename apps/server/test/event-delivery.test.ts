import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { eventMatches, eventMatchAudit, eventPlanBrackets, eventPlans, players, sets, tournamentParticipants, tournaments, user, type Db } from '@smashclub/db';
import type { SessionUser } from '../src/auth';
import { deliverMatchScore, deliveryStatus, type ScoreSender } from '../src/event-operations/delivery';
import { ChallongeScoreError, type DeliverScoreInput } from '../src/challonge/scoreClient';
import { loadEnv } from '../src/env';
import { createTestDb } from './helpers/testDb';
let db: Db; let close: () => Promise<void>; let match: typeof eventMatches.$inferSelect;
const admin: SessionUser = { id: 'admin', role: 'admin', name: 'TO', email: 'to@example.test' };
const member: SessionUser = { id: 'member', role: 'user', name: 'Player', email: 'player@example.test' };
const config = { enabled: true, apiKey: 'fake-key' };
const input = () => ({ matchId: match.id, expectedRevision: match.revision });
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(user).values([admin, member]);
  const entrants = await db.insert(players).values([{ canonicalName: 'First' }, { canonicalName: 'Second' }]).returning();
  const [plan] = await db.insert(eventPlans).values({ name: 'Event', eventDate: new Date(), status: 'underway' }).returning();
  const [tournament] = await db.insert(tournaments).values({ challongeSlug: 'example', name: 'Example' }).returning();
  await db.insert(eventPlanBrackets).values({ eventPlanId: plan!.id, division: 'upper', stage: 'main', tournamentId: tournament!.id });
  const participants = await db.insert(tournamentParticipants).values(entrants.map((p, index) => ({ tournamentId: tournament!.id, playerId: p.id, challongeParticipantId: index + 1, rawName: 'Private', cleanedName: 'Private' }))).returning();
  const [source] = await db.insert(sets).values({ tournamentId: tournament!.id, challongeMatchId: 9, state: 'open', p1ParticipantId: participants[1]!.id, p2ParticipantId: participants[0]!.id, p1PlayerId: entrants[1]!.id, p2PlayerId: entrants[0]!.id }).returning();
  [match] = await db.insert(eventMatches).values({ eventPlanId: plan!.id, sourceKey: 'fixture', sourceSetId: source!.id, division: 'upper', stage: 'main', label: 'Final', status: 'complete', player1Id: entrants[0]!.id, player2Id: entrants[1]!.id, score1: 3, score2: 1, winnerId: entrants[0]!.id, outcome: 'played' }).returning() as [typeof eventMatches.$inferSelect];
});
afterEach(async () => close());
function sender(callback?: (payload: DeliverScoreInput) => void): ScoreSender {
  return { deliverScore: async payload => { callback?.(payload); return { status: 'verified', match: { id: '9', participantIds: ['1', '2'], state: 'complete', scores: { '1': 3, '2': 1 }, winnerId: '1' } }; } };
}
describe('explicit score delivery', () => {
  it('defaults off and never sends when disabled', async () => {
    expect(loadEnv({ DATABASE_URL: 'postgres://localhost/test' }).CHALLONGE_SCORE_WRITES).toBe(false);
    let sent = false;
    await expect(deliverMatchScore(db, admin, input(), { ...config, enabled: false }, sender(() => { sent = true; }))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(sent).toBe(false); expect(await db.select().from(eventMatchAudit)).toHaveLength(0);
  });
  it('requires event operator privileges for status and sending', async () => {
    await expect(deliveryStatus(db, member, match.eventPlanId, config)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(deliverMatchScore(db, member, input(), config, sender())).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('maps local score orientation to external participant IDs and audits success', async () => {
    let payload: DeliverScoreInput | undefined;
    const result = await deliverMatchScore(db, admin, input(), config, sender(value => { payload = value; }));
    expect(payload).toMatchObject({ tournamentSlug: 'example', matchId: '9', participants: [{ participantId: '1', score: 3 }, { participantId: '2', score: 1 }] });
    expect(result).toMatchObject({ ok: true, status: 'verified', revision: 2 });
    expect((await db.select().from(eventMatches))[0]).toMatchObject({ syncState: 'synced', score1: 3, score2: 1, revision: 2 });
    expect((await db.select().from(eventMatchAudit))[0]!.action).toBe('delivery_verified');
  });
  it('preserves verified child aliases despite reversed local and imported orientation', async () => {
    await db.update(eventMatches).set({ stage: 'group' }).where(eq(eventMatches.id, match.id));
    await db.update(sets).set({ resultStage: 'group', raw: { player1Id: 2, sourcePlayer1Id: 102, player2Id: 1, sourcePlayer2Id: 101 } }).where(eq(sets.id, match.sourceSetId!));
    let payload: DeliverScoreInput | undefined;
    await deliverMatchScore(db, admin, input(), config, sender(value => { payload = value; }));
    expect(payload!.participants).toEqual([{ participantId: '1', aliases: ['101'], score: 3 }, { participantId: '2', aliases: ['102'], score: 1 }]);
  });
  it('persists ambiguous failures and original local scores rather than rolling back', async () => {
    const result = await deliverMatchScore(db, admin, input(), config, { deliverScore: async () => { throw new ChallongeScoreError('ambiguous', 'Remote outcome unknown.', true); } });
    expect(result).toMatchObject({ ok: false, mayHaveWritten: true, status: 'ambiguous' });
    expect((await db.select().from(eventMatches))[0]).toMatchObject({ syncState: 'error', score1: 3, score2: 1 });
    expect((await db.select().from(eventMatchAudit))[0]!.action).toBe('delivery_failed');
  });
  it('serialises simultaneous TO delivery requests without duplicate writes', async () => {
    let sends = 0;
    const transport = sender(() => { sends++; });
    const outcomes = await Promise.allSettled([
      deliverMatchScore(db, admin, input(), config, transport),
      deliverMatchScore(db, admin, input(), config, transport),
    ]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(sends).toBe(1);
    expect(await db.select().from(eventMatchAudit)).toHaveLength(1);
  });
  it('rejects stale revisions before any delivery attempt', async () => {
    await expect(deliverMatchScore(db, admin, { ...input(), expectedRevision: 7 }, config, sender())).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await db.select().from(eventMatchAudit)).toHaveLength(0);
  });
  it('rejects unlinked source participants without guessing', async () => {
    await db.update(sets).set({ p1ParticipantId: null }).where(eq(sets.id, match.sourceSetId!));
    await expect(deliverMatchScore(db, admin, input(), config, sender())).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await db.select().from(eventMatchAudit)).toHaveLength(0);
  });
  it('blocks a previous process-interrupted attempt', async () => {
    await db.insert(eventMatchAudit).values({ eventPlanId: match.eventPlanId, matchId: match.id, userId: admin.id, action: 'delivery_started', before: {}, after: {} });
    await expect(deliverMatchScore(db, admin, input(), config, sender())).rejects.toThrow(/interrupted/);
  });
  it('keeps closed event matches read-only', async () => {
    await db.update(eventPlans).set({ status: 'complete' }).where(eq(eventPlans.id, match.eventPlanId));
    await expect(deliverMatchScore(db, admin, input(), config, sender())).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
