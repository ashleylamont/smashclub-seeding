import { publicPlayerName } from '@smashclub/shared';
import { SNAP_EVENT } from '@rotorsoft/act';
import { eq } from 'drizzle-orm';
import {
  nativeLiveHandoffs,
  user,
  players,
  type Db,
  type eventMatchAudit,
  type eventAttendanceAudit,
} from '@smashclub/db';
import { nativeStream, type NativeRuntime } from './runtime';
import { Baseline, Decision, LiveState, type TournamentBaseline } from './schemas';
import { describeDecision, type HistoryCategory, type HistoryContext } from './historySummary';

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

const decisionNames = [
  'DecisionRecordedV1',
  'DecisionRecordedV2',
  'DecisionRecordedV3',
  'DecisionRecordedV4',
  'DecisionRecordedV5',
  'DecisionRecordedV6',
  'DecisionRecordedV7',
  'DecisionRecordedV8',
  'DecisionRecordedV9',
  'DecisionRecordedV10',
  'ResultsSealedV1',
  'PlanRetiredV1',
];
const historyNames = [
  'BaselineCapturedV1',
  'LegacyStateImportedV1',
  ...decisionNames,
  'PublicationRecordedV1',
];
const isOrigin = (name: string) =>
  name === 'BaselineCapturedV1' || name === 'LegacyStateImportedV1';
const maxContextEvents = 100;

function updateContext(context: HistoryContext, after: HistoryContext): HistoryContext {
  const {
    entrants = context.entrants,
    matches = context.matches,
    brackets = context.brackets,
    reports = context.reports,
    stations = context.stations,
    settings = context.settings,
  } = after;
  return { entrants, matches, brackets, reports, stations, settings };
}

function baselineContext(baseline: TournamentBaseline): HistoryContext {
  return updateContext({}, { ...baseline, brackets: baseline.brackets ?? [], reports: [] });
}

async function contextBefore(runtime: NativeRuntime, stream: string, before: number) {
  const query = { stream, stream_exact: true, before, backward: true, with_pii: false };
  const [checkpoint] = await runtime.app.query_array({
    ...query,
    // An explicit after bound bypasses Act's newest-checkpoint floor for older pages.
    after: -1,
    with_snaps: true,
    names: [SNAP_EVENT],
    limit: 1,
  });
  const parsed = LiveState.safeParse(
    (checkpoint?.data as { current?: unknown[] } | undefined)?.current?.[0],
  );
  const seed = checkpoint && parsed.success ? { id: checkpoint.id, state: parsed.data } : null;
  const prefix = await runtime.app.query_array({
    ...query,
    after: seed?.id ?? -1,
    names: historyNames,
    limit: maxContextEvents,
  });
  // A full window may have omitted intervening facts. Only use fields actually
  // recovered in that window, never stale checkpoint fields or the current draw.
  let context = seed && prefix.length < maxContextEvents ? updateContext({}, seed.state) : {};
  for (const event of prefix.reverse()) {
    if (event.name === 'BaselineCapturedV1') context = baselineContext(Baseline.parse(event.data));
    else if (event.name === 'LegacyStateImportedV1')
      context = updateContext({}, LiveState.parse(event.data));
    else if (decisionNames.includes(event.name))
      context = updateContext(context, Decision.parse(event.data).after);
  }
  return context;
}

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
  const playerNames = new Map(
    (
      await db
        .select({
          id: players.id,
          displayName: players.displayName,
          canonicalName: players.canonicalName,
        })
        .from(players)
    ).map((player) => [player.id, publicPlayerName(player)]),
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
  const stream = nativeStream(planId);
  const events = await runtime.app.query_array({
    stream,
    stream_exact: true,
    after: -1,
    before: cursor?.before,
    backward: true,
    limit: limit + 1,
    names: historyNames,
  });
  const page = events.slice(0, limit);
  const oldest = page.at(-1);
  let context =
    oldest && !isOrigin(oldest.name) ? await contextBefore(runtime, stream, oldest.id) : {};
  page.reverse();
  const entries = page.map((event): HistoryEntry => {
    const actor = event.meta.causation.action?.actor;
    const common = {
      id: `act:${event.id}`,
      eventName: event.name,
      version: event.version,
      at: event.created.toISOString(),
    };
    if (decisionNames.includes(event.name)) {
      const decision = Decision.parse(event.data);
      context = updateContext(context, decision.after);
      return {
        ...common,
        ...describeDecision(decision, context, (id) => playerNames.get(id)),
        actor: actor?.name ?? names.get(decision.actorId) ?? 'Former participant',
        source: decision.source,
        details: {
          command: decision.command,
          commandId: decision.commandId,
          sequence: decision.receipt.sequence,
          correctionOf: decision.correctionOf,
          causedBy: decision.causation,
          ...(decision.finalsReplayCompanion && {
            finalsReplayCompanion: decision.finalsReplayCompanion,
          }),
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
    const importedState = migrated ? LiveState.parse(event.data) : undefined;
    const baseline = importedState?.baseline ?? Baseline.parse(event.data);
    context = importedState ? updateContext({}, importedState) : baselineContext(baseline);
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
  entries.reverse();
  const nextCursor: HistoryCursor | null =
    events.length > limit
      ? { source: 'act', before: events[limit - 1]!.id }
      : legacy.length
        ? { source: 'imported', before: legacy.length }
        : null;
  return { entries, nextCursor };
}
