import { and, eq, inArray } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { eventMatchAudit, eventMatches, eventPlanBrackets, eventPlans, sets, tournamentParticipants, tournaments, type Db } from '@smashclub/db';
import type { SessionUser } from '../auth';
import { ChallongeScoreClient, ChallongeScoreError, type DeliverScoreInput } from '../challonge/scoreClient';
import { lockEvent, requireOperator } from './service';

export interface DeliveryConfig { enabled: boolean; apiKey?: string; }
export type ScoreSender = Pick<ChallongeScoreClient, 'deliverScore'>;
export type DeliveryResult = { ok: boolean; matchId: string; revision: number; status: string; message?: string; mayHaveWritten?: boolean };
const conflict = (message: string): never => { throw new TRPCError({ code: 'CONFLICT', message }); };

export async function deliveryStatus(db: Db, user: SessionUser, planId: string, config: DeliveryConfig) {
  await requireOperator(db, planId, user);
  return { enabled: config.enabled, hasCredentials: Boolean(config.apiKey?.trim()) };
}

/** Local confirmation and remote delivery are separate, explicit operations. */
export async function deliverMatchScore(
  db: Db, user: SessionUser, input: { matchId: string; expectedRevision: number }, config: DeliveryConfig,
  sender?: ScoreSender,
): Promise<DeliveryResult> {
  if (!config.enabled || !config.apiKey?.trim()) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Challonge score delivery is disabled or credentials are missing. Use the manual handoff.' });
  // A committed start record survives a process crash or ambiguous transport.
  const attempt = await db.transaction(async tx => {
    const [initial] = await tx.select().from(eventMatches).where(eq(eventMatches.id, input.matchId));
    if (!initial) throw new TRPCError({ code: 'NOT_FOUND', message: 'Match not found.' });
    await lockEvent(tx, initial.eventPlanId);
    await requireOperator(tx, initial.eventPlanId, user);
    const [match] = await tx.select().from(eventMatches).where(eq(eventMatches.id, initial.id)).for('update');
    if (!match || match.revision !== input.expectedRevision) return conflict('Match changed; refresh before sending.');
    if (match.status !== 'complete' || match.outcome !== 'played' || !match.player1Id || !match.player2Id || match.score1 === null || match.score2 === null || !match.sourceSetId) {
      return conflict('Only completed played matches linked to an imported Challonge match can be delivered.');
    }
    if (match.score1 === match.score2 || match.winnerId !== (match.score1 > match.score2 ? match.player1Id : match.player2Id)) return conflict('The local result needs correction before delivery.');
    const [unfinished] = await tx.select().from(eventMatchAudit).where(and(eq(eventMatchAudit.matchId, match.id), eq(eventMatchAudit.action, 'delivery_started'))).limit(1);
    if (unfinished) return conflict('A previous delivery was interrupted. Reconcile its remote result before another delivery attempt.');
    const [source] = await tx.select().from(sets).where(eq(sets.id, match.sourceSetId));
    if (!source) return conflict('Imported match no longer exists. Re-import first.');
    const [linked] = await tx.select().from(eventPlanBrackets).where(and(eq(eventPlanBrackets.eventPlanId, match.eventPlanId), eq(eventPlanBrackets.tournamentId, source.tournamentId), eq(eventPlanBrackets.division, match.division), eq(eventPlanBrackets.stage, match.stage === 'consolation' ? 'consolation' : 'main')));
    if (!linked) return conflict('The imported match is not attached to this event division and stage.');
    const [tournament] = await tx.select().from(tournaments).where(eq(tournaments.id, source.tournamentId));
    if (!tournament || source.resultStage !== (match.stage === 'group' ? 'group' : 'final')) return conflict('The imported match stage no longer matches.');
    const participants = await tx.select().from(tournamentParticipants).where(and(eq(tournamentParticipants.tournamentId, source.tournamentId), inArray(tournamentParticipants.id, [source.p1ParticipantId, source.p2ParticipantId].filter((value): value is string => value !== null))));
    const map = (playerId: string, score: number) => {
      const matches = participants.filter(participant => participant.playerId === playerId);
      if (matches.length !== 1) return conflict('Participant identities are not reconciled; re-import before delivery.');
      const participantId = String(matches[0]!.challongeParticipantId);
      const raw = source.raw && typeof source.raw === 'object' ? source.raw as Record<string, unknown> : {};
      // Preserve root identity while supplying only aliases explicitly paired
      // with that root by the imported module payload. Never infer by local order.
      const aliases = source.resultStage === 'group' ? [1, 2].flatMap(slot => {
        const childId = raw[`sourcePlayer${slot}Id`];
        return String(raw[`player${slot}Id`]) === participantId &&
          (typeof childId === 'number' || typeof childId === 'string') && /^[1-9]\d*$/.test(String(childId))
          ? [String(childId)] : [];
      }) : [];
      return { participantId, ...(aliases.length ? { aliases } : {}), score };
    };
    if (new Set([source.p1PlayerId, source.p2PlayerId]).size !== 2 || ![source.p1PlayerId, source.p2PlayerId].includes(match.player1Id) || ![source.p1PlayerId, source.p2PlayerId].includes(match.player2Id)) return conflict('Imported player identities differ from the local match.');
    const payload: DeliverScoreInput = { tournamentSlug: tournament.challongeSlug, matchId: String(source.challongeMatchId), participants: [map(match.player1Id, match.score1), map(match.player2Id, match.score2)] };
    const revision = match.revision + 1;
    await tx.update(eventMatches).set({ revision, syncState: 'pending' }).where(eq(eventMatches.id, match.id));
    const [audit] = await tx.insert(eventMatchAudit).values({ eventPlanId: match.eventPlanId, matchId: match.id, userId: user.id, action: 'delivery_started', before: match, after: { revision, payload } }).returning();
    return { auditId: audit!.id, planId: match.eventPlanId, matchId: match.id, revision, payload };
  });
  const client = sender ?? new ChallongeScoreClient({ apiKey: config.apiKey });
  return db.transaction(async tx => {
    // Serialise score corrections and event closure with the network attempt.
    // Lock without lockEvent here: closure between transactions is persisted as
    // an aborted attempt rather than leaving a dangling delivery_started row.
    const [plan] = await tx.select().from(eventPlans).where(eq(eventPlans.id, attempt.planId)).for('update');
    const [match] = await tx.select().from(eventMatches).where(eq(eventMatches.id, attempt.matchId)).for('update');
    let result: DeliveryResult;
    try {
      await requireOperator(tx, attempt.planId, user);
      if (!plan || ['complete', 'cancelled'].includes(plan.status) || !match || match.revision !== attempt.revision) throw new ChallongeScoreError('remote_conflict', 'Event or match changed before delivery; no write was attempted.');
      const sent = await client.deliverScore(attempt.payload);
      result = { ok: true, matchId: attempt.matchId, revision: attempt.revision + 1, status: sent.status };
    } catch (error) {
      const known = error instanceof ChallongeScoreError;
      result = { ok: false, matchId: attempt.matchId, revision: (match?.revision ?? attempt.revision) + 1, status: known ? error.code : 'unavailable', message: known ? error.message : 'Delivery failed. Reconcile the remote match before trying again.', mayHaveWritten: known ? error.mayHaveWritten : true };
    }
    if (match) await tx.update(eventMatches).set({ syncState: result.ok ? 'synced' : 'error', revision: result.revision }).where(eq(eventMatches.id, attempt.matchId));
    await tx.update(eventMatchAudit).set({ action: result.ok ? 'delivery_verified' : 'delivery_failed', after: { ...result, payload: attempt.payload } }).where(eq(eventMatchAudit.id, attempt.auditId));
    return result;
  });
}
