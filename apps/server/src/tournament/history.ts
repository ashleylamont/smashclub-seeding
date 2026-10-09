import { eq } from 'drizzle-orm';
import {
  nativeLiveHandoffs,
  user,
  type Db,
  type eventMatchAudit,
  type eventAttendanceAudit,
} from '@smashclub/db';
import type { NativeRuntime } from './runtime';
import { Baseline, Decision, LiveState } from './schemas';
import { describeDecision, type HistoryCategory } from './historySummary';

export type HistoryCursor = { source: 'act' | 'imported'; before: number };
export type HistoryEntry = {
  id: string;
  eventName: string;
  version: number | null;
  at: string;
  actor: string;
  source: 'operator' | 'attendee' | 'guest' | 'system' | 'imported';
  category: HistoryCategory;
  title: string;
  summary: string;
  matchId: string | null;
  details: object;
};
type ImportedAudit = {
  legacyAudit?: (typeof eventMatchAudit.$inferSelect)[];
  legacyAttendance?: (typeof eventAttendanceAudit.$inferSelect)[];
};

/** Exact stream, newest first, no snapshots or full-state payloads in the response. */
export async function nativeEventHistory(
  runtime: NativeRuntime,
  db: Db,
  planId: string,
  cursor?: HistoryCursor,
  limit = 50,
) {
  const [handoff] = await db
    .select()
    .from(nativeLiveHandoffs)
    .where(eq(nativeLiveHandoffs.eventPlanId, planId));
  if (!handoff) return { entries: [] as HistoryEntry[], nextCursor: null as HistoryCursor | null };
  const names = new Map(
    (await db.select({ id: user.id, name: user.name }).from(user)).map((item) => [
      item.id,
      item.name,
    ]),
  );
  const imported = handoff.baseline as ImportedAudit;
  const legacy = [...(imported.legacyAudit ?? []), ...(imported.legacyAttendance ?? [])].sort(
    (a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.id.localeCompare(b.id),
  );
  if (cursor?.source === 'imported') {
    const before = Math.min(cursor.before, legacy.length);
    const start = Math.max(0, before - limit);
    return {
      entries: legacy
        .slice(start, before)
        .reverse()
        .map((item): HistoryEntry => ({
          id: `imported:${item.id}`,
          eventName: item.action,
          version: null,
          at: new Date(item.createdAt).toISOString(),
          actor: item.userId ? (names.get(item.userId) ?? 'Former organiser') : 'Guest',
          source: 'imported',
          category:
            'matchId' in item
              ? /score|report|result/.test(item.action)
                ? 'scores'
                : 'matches'
              : 'players',
          title: item.action.replaceAll('_', ' '),
          summary: 'Original audit record retained from before the live history started.',
          matchId: 'matchId' in item ? item.matchId : null,
          details:
            'before' in item
              ? { before: item.before, after: item.after }
              : { details: item.details },
        })),
      nextCursor: start ? { source: 'imported' as const, before: start } : null,
    };
  }
  const state = await runtime.state(planId);
  const events = await runtime.app.query_array({
    stream: `native:${planId}`,
    stream_exact: true,
    after: -1,
    before: cursor?.before,
    backward: true,
    limit: limit + 1,
    names: [
      'BaselineCapturedV1',
      'LegacyStateImportedV1',
      'DecisionRecordedV1',
      'ResultsSealedV1',
      'PublicationRecordedV1',
    ],
  });
  const entries = events.slice(0, limit).map((event): HistoryEntry => {
    const actor = event.meta.causation.action?.actor;
    const common = {
      id: `act:${event.id}`,
      eventName: event.name,
      version: event.version,
      at: event.created.toISOString(),
    };
    if (event.name === 'DecisionRecordedV1' || event.name === 'ResultsSealedV1') {
      const decision = Decision.parse(event.data);
      return {
        ...common,
        ...describeDecision(decision, state),
        actor: actor?.name ?? names.get(decision.actorId) ?? 'Former participant',
        source: decision.source,
        details: {
          command: decision.command,
          commandId: decision.commandId,
          sequence: decision.receipt.sequence,
          correctionOf: decision.correctionOf,
          causedBy: decision.causation,
        },
      };
    }
    if (event.name === 'PublicationRecordedV1') {
      const publication = event.data as { resultId: string; tournamentIds: string[] };
      return {
        ...common,
        actor: 'Publication worker',
        source: 'system',
        category: 'results',
        title: 'Results published',
        summary: `${publication.tournamentIds.length} result brackets published to club history.`,
        matchId: null,
        details: publication,
      };
    }
    const migrated = event.name === 'LegacyStateImportedV1';
    const baseline = migrated ? LiveState.parse(event.data).baseline! : Baseline.parse(event.data);
    return {
      ...common,
      actor: names.get(baseline.capturedBy) ?? 'Automatic migration',
      source: migrated ? 'system' : 'operator',
      category: 'draw',
      title: migrated ? 'Existing event imported' : 'Live history started',
      summary: `${baseline.entrants.length} entrants · ${baseline.pools.length} pools${migrated ? ' · original audit records retained' : ' · draw captured'}`,
      matchId: null,
      details: {
        capturedAt: new Date(baseline.capturedAt).toISOString(),
        rankingRecomputeId: baseline.rankingRecomputeId,
        importedAuditRecords: legacy.length,
      },
    };
  });
  const nextCursor: HistoryCursor | null =
    events.length > limit
      ? { source: 'act', before: events[limit - 1]!.id }
      : legacy.length
        ? { source: 'imported', before: legacy.length }
        : null;
  return { entries, nextCursor };
}
