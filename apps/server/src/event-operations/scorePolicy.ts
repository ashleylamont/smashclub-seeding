import { and, eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { eventMatches, eventOperationSettings, eventPlans, eventScoreReports, type Db } from '@smashclub/db';
import { canAutoAcceptPoolScore } from './selfService';
import type { ScoreInput } from './service';

type Match = typeof eventMatches.$inferSelect;
const changed = (): never => { throw new TRPCError({ code: 'CONFLICT', message: 'This match changed. Refresh the match list before submitting.' }); };
export const samePlayedScore = (match: Match, input: Pick<ScoreInput, 'score1' | 'score2' | 'outcome'>, winnerId: string) => match.status === 'complete' && match.outcome === input.outcome && match.score1 === input.score1 && match.score2 === input.score2 && match.winnerId === winnerId;

/** Caller holds the event lock and has checked attendee access and withdrawals. */
export async function attendeeScoreDecision(db: Db, match: Match, input: ScoreInput, winnerId: string) {
  const [settings] = await db.select().from(eventOperationSettings).where(eq(eventOperationSettings.eventPlanId, match.eventPlanId));
  const [plan] = await db.select().from(eventPlans).where(eq(eventPlans.id, match.eventPlanId));
  const policy = settings?.scoreReportingMode === 'approve_unless_disputed' && plan?.bracketMode === 'native';
  if (input.outcome !== 'played' || !['ready', 'playing'].includes(match.status) && !(policy && match.status === 'complete' && match.outcome === 'played')) changed();
  const reports = await db.select().from(eventScoreReports).where(eq(eventScoreReports.matchId, match.id));
  if (match.revision !== input.expectedRevision) {
    // Admit the losing concurrent request only across the result written by an
    // automatic first report. A later TO correction/participant edit has no
    // matching provenance and must still invalidate the old form.
    const automaticResult = policy && match.revision === input.expectedRevision + 1 && reports.some(report => report.autoApproved && report.status === 'approved' && report.expectedRevision === input.expectedRevision && samePlayedScore(match, report, report.winnerId));
    if (!automaticResult) changed();
  }
  if (match.status === 'complete') {
    const agrees = samePlayedScore(match, input, winnerId);
    return { apply: false, status: agrees ? 'approved' as const : 'pending' as const, autoApproved: false, isDispute: !agrees, expectedRevision: match.revision };
  }
  const priorConflicts = policy && reports.some(report => report.status === 'pending' && report.expectedRevision === match.revision && (report.score1 !== input.score1 || report.score2 !== input.score2 || report.winnerId !== winnerId || report.outcome !== input.outcome));
  if (priorConflicts) {
    // Changing policy must not silently choose between already conflicting scores.
    await db.update(eventScoreReports).set({ isDispute: true }).where(and(eq(eventScoreReports.matchId, match.id), eq(eventScoreReports.status, 'pending'), eq(eventScoreReports.expectedRevision, match.revision)));
    return { apply: false, status: 'pending' as const, autoApproved: false, isDispute: true, expectedRevision: match.revision };
  }
  const accepted = policy || await canAutoAcceptPoolScore(db, match);
  if (accepted && policy) {
    // Existing agreeing submissions become confirmations; they must not leave
    // an unnecessary approval task blocking the next stage.
    for (const report of reports.filter(report => report.status === 'pending' && report.expectedRevision === match.revision && report.score1 === input.score1 && report.score2 === input.score2 && report.winnerId === winnerId && report.outcome === input.outcome)) {
      await db.update(eventScoreReports).set({ status: 'approved', isDispute: false }).where(eq(eventScoreReports.id, report.id));
    }
  }
  return { apply: accepted, status: accepted ? 'approved' as const : 'pending' as const, autoApproved: accepted, isDispute: false, expectedRevision: match.revision };
}
