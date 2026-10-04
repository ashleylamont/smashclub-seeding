import { randomUUID } from 'node:crypto';
import { act, ConcurrencyError, InMemoryCache, type Store } from '@rotorsoft/act';
import { PostgresStore } from '@rotorsoft/act-pg';
import { and, eq, isNull } from 'drizzle-orm';
import {
  nativeLiveHandoffs,
  nativeRatingIntents,
  nativeResultPublications,
  players,
  type Db,
} from '@smashclub/db';
import { publicPlayerName } from '@smashclub/shared';
import type { SessionUser } from '../auth';
import { isOperator, requireOperator } from '../event-operations/access';
import { NativeTournament } from './aggregate';
import {
  Baseline,
  Command,
  Decision,
  Envelope,
  initialState,
  type TournamentCommand,
} from './schemas';
import { stageNativeBaseline } from './baseline';
import { publishNativeResult, processNativeRatingIntents } from './publication';
import { captureBaseline, receiptKey, reduceDecision, TournamentConflict } from './domain';

export const nativeStream = (planId: string) => `native:${planId}`;
const systemActor = { id: 'native-publication', name: 'Native publication worker' };

/** Each runtime owns its cache and store; no process-global store injection. */
export function createNativeRuntime(
  db: Db,
  store: Store,
  fault?: Parameters<typeof publishNativeResult>[2],
) {
  const app = act()
    .withState(NativeTournament)
    .on('ResultsSealedV1')
    .do(
      async function publishSealedNativeResults(event, _stream, dispatcher) {
        const result = event.data.after.result;
        if (!result) throw new TournamentConflict('Missing sealed results.');
        const ack = await publishNativeResult(db, result, fault);
        for (let attempt = 0; ; attempt++) {
          const current = await dispatcher.load(NativeTournament, event.stream);
          try {
            await dispatcher.do(
              'AcknowledgeNativePublication',
              { stream: event.stream, actor: systemActor, expectedVersion: current.version },
              ack,
            );
            break;
          } catch (error) {
            if (!(error instanceof ConcurrencyError) || attempt >= 7) throw error;
          }
        }
      },
      {
        blockOnError: true,
        maxRetries: 10,
        backoff: { strategy: 'exponential', baseMs: 100, maxMs: 30_000 },
      },
    )
    .to((event) => ({ source: event.stream, target: `native-publication:${event.stream}` }))
    .build({
      scoped: { store, cache: new InMemoryCache({ maxSize: 128 }) },
      listen: false,
      validateFoldedState: true,
    });

  async function transfer(planId: string) {
    const [handoff] = await db
      .select()
      .from(nativeLiveHandoffs)
      .where(eq(nativeLiveHandoffs.eventPlanId, planId));
    if (!handoff) throw new TournamentConflict('This event has not been adopted into Act.');
    const baseline = Baseline.parse(handoff.baseline);
    for (let attempt = 0; ; attempt++) {
      const current = await app.load(NativeTournament, nativeStream(planId));
      try {
        await app.do(
          'CaptureNativeBaseline',
          {
            stream: nativeStream(planId),
            actor: { id: baseline.capturedBy, name: 'Baseline transfer' },
            expectedVersion: current.version,
          },
          baseline,
        );
        return;
      } catch (error) {
        if (!(error instanceof ConcurrencyError) || attempt >= 7) throw error;
      }
    }
  }
  async function command(
    actor: SessionUser,
    planId: string,
    requestId: string,
    input: TournamentCommand,
  ) {
    const parsed = Command.parse(input);
    const operator = await isOperator(db, planId, actor);
    if (parsed.kind !== 'score') await requireOperator(db, planId, actor);
    await transfer(planId);
    const envelope = Envelope.parse({
      id: randomUUID(),
      requestId,
      actorId: actor.id,
      operator,
      at: Date.now(),
      command: parsed,
    });
    // Contention is internal. Semantic match/resource preconditions are checked again
    // in the action after each fresh load; unrelated commits do not reject a score.
    for (let attempt = 0; ; attempt++) {
      const current = await app.load(NativeTournament, nativeStream(planId));
      try {
        const changed = await app.do(
          'ExecuteNativeCommand',
          {
            stream: nativeStream(planId),
            actor: { id: actor.id, name: actor.name },
            expectedVersion: current.version,
          },
          envelope,
        );
        const state = changed.at(-1)!.state.current[0];
        return {
          receipt: state.receipts[receiptKey(actor.id, requestId)]!,
          match:
            parsed.kind === 'score' || parsed.kind === 'dispatch'
              ? state.matches.find((m) => m.id === parsed.matchId)
              : null,
          publicationStatus: state.result
            ? state.publication
              ? ('published' as const)
              : ('pending' as const)
            : null,
        };
      } catch (error) {
        if (!(error instanceof ConcurrencyError) || attempt >= 7) throw error;
      }
    }
  }
  async function snapshot(planId: string, privateView = false, cursor?: number) {
    const state = (await app.load(NativeTournament, nativeStream(planId))).state.current[0];
    if (!state.baseline)
      throw new TournamentConflict(
        'Baseline transfer is pending. Retry or ask an organiser to recover it.',
      );
    if (!privateView && !state.settings.published)
      throw new TournamentConflict('This event is not published.');
    let publicationBlocked = false;
    await store.query_streams(
      (position) => {
        publicationBlocked = position.blocked;
      },
      {
        stream: `native-publication:${nativeStream(planId)}`,
        stream_exact: true,
      },
    );
    const names = new Map(
      (await db.select().from(players)).map((p) => [p.id, publicPlayerName(p)]),
    );
    const publicState = {
      plan: {
        id: planId,
        name: state.baseline.name,
        eventDate: new Date(state.baseline.eventDate).toISOString(),
        status: state.lifecycle === 'finalized' ? 'complete' : 'underway',
        bracketMode: 'native' as const,
        softLockedAt:
          state.lifecycle === 'unlocked' ? null : new Date(state.baseline.capturedAt).toISOString(),
      },
      // Domain cursor excludes Act checkpoints and reaction subscription events.
      cursor: state.sequence,
      unchanged: cursor === state.sequence,
      resync: cursor !== undefined && cursor !== state.sequence,
      matches: state.matches.map((m) => ({
        ...m,
        player1Name: m.player1Id ? (names.get(m.player1Id) ?? 'Player') : 'TBD',
        player2Name: m.player2Id ? (names.get(m.player2Id) ?? 'Player') : 'TBD',
        pendingDisputeCount: state.reports.filter(
          (r) => r.matchId === m.id && r.status === 'pending' && r.isDispute,
        ).length,
      })),
      entrants: state.entrants.map((e) => ({
        id: e.playerId,
        name: names.get(e.playerId) ?? 'Player',
      })),
      pools: state.pools,
      nativeBrackets: state.brackets,
      stations: state.stations,
      settings: state.settings,
      publication: state.result
        ? {
            resultId: state.result.id,
            revision: state.result.revision,
            status: state.publication
              ? ('published' as const)
              : publicationBlocked
                ? ('blocked' as const)
                : ('pending' as const),
            tournamentIds: state.publication?.tournamentIds ?? [],
          }
        : null,
    };
    if (!privateView) return { ...publicState, reports: [], audit: [] };
    const audit: {
      kind: string;
      actorId: string;
      at: number;
      sequence: number;
      command: typeof Command._output;
      source: string;
      correctionOf: string | null;
    }[] = [];
    await app.query({ stream: nativeStream(planId) }, (event) => {
      if (event.name === 'DecisionRecordedV1' || event.name === 'ResultsSealedV1') {
        const data = Decision.parse(event.data);
        audit.push({
          kind: data.kind,
          actorId: data.actorId,
          at: data.at,
          sequence: data.receipt.sequence,
          command: data.command,
          source: data.source,
          correctionOf: data.correctionOf,
        });
      }
    });
    return { ...publicState, reports: state.reports, audit: audit.slice(-100) };
  }
  /** Full event scan, explicitly excluding Act snapshots; never dispatch/reactions. */
  async function replay(planId: string) {
    let rebuilt = initialState();
    await app.query({ stream: nativeStream(planId), after: -1 }, (event) => {
      switch (event.name) {
        case 'BaselineCapturedV1':
          rebuilt = captureBaseline(Baseline.parse(event.data));
          break;
        case 'DecisionRecordedV1':
        case 'ResultsSealedV1':
          rebuilt = reduceDecision(rebuilt, Decision.parse(event.data));
          break;
        case 'PublicationRecordedV1':
          rebuilt = {
            ...rebuilt,
            publication: event.data as NonNullable<typeof rebuilt.publication>,
            sequence: rebuilt.sequence + 1,
          };
          break;
        default:
          throw new TournamentConflict(`Unsupported native event schema: ${String(event.name)}`);
      }
    });
    return rebuilt;
  }
  async function recover() {
    const handoffs = await db.select().from(nativeLiveHandoffs);
    for (const handoff of handoffs) await transfer(handoff.eventPlanId);
    await drainReactions();
  }
  async function drainReactions() {
    // settle() schedules asynchronous work and returns void. Use the bounded,
    // synchronous correlate/drain APIs when a recovery caller awaits completion.
    let lastId = -1;
    for (let pass = 0; pass < 32; pass++) {
      const correlation = await app.correlate({ after: -1, limit: 1000 });
      const drain = await app.drain({ eventLimit: 1000 });
      if (correlation.last_id === lastId && !drain.leased.length) break;
      lastId = correlation.last_id;
    }
  }
  async function recoverPublication(planId: string) {
    await transfer(planId);
    await app.unblock([`native-publication:${nativeStream(planId)}`]);
    await drainReactions();
    return snapshot(planId, true);
  }
  return {
    app,
    command,
    transfer,
    snapshot,
    replay,
    recover,
    drainReactions,
    recoverPublication,
    adopt: async (actor: SessionUser, planId: string) => {
      await stageNativeBaseline(db, actor, planId);
      await transfer(planId);
      return snapshot(planId, true);
    },
    ratingStatus: async (planId: string) =>
      db
        .select({
          resultId: nativeRatingIntents.resultId,
          completedAt: nativeRatingIntents.completedAt,
        })
        .from(nativeRatingIntents)
        .innerJoin(
          nativeResultPublications,
          eq(nativeResultPublications.resultId, nativeRatingIntents.resultId),
        )
        .where(
          and(
            eq(nativeResultPublications.eventPlanId, planId),
            isNull(nativeRatingIntents.completedAt),
          ),
        ),
    shutdown: async () => {
      await app.shutdown();
      await store.dispose();
    },
  };
}
export type NativeRuntime = ReturnType<typeof createNativeRuntime>;

export async function createPostgresNativeRuntime(db: Db, connectionString: string) {
  const store = new PostgresStore({ connectionString, schema: 'native_act', table: 'events' });
  await store.seed();
  return createNativeRuntime(db, store);
}

/** Poll durable transfer/reaction/rating work; restart safely resumes each boundary. */
export function startNativeWorker(
  runtime: NativeRuntime,
  db: Db,
  onError: (error: unknown) => void,
) {
  let running: Promise<void> | undefined;
  const tick = async () => {
    if (running) return;
    running = (async () => {
      try {
        await runtime.recover();
        await processNativeRatingIntents(db);
      } catch (error) {
        onError(error);
      }
    })();
    try {
      await running;
    } finally {
      running = undefined;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), 5000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await running;
  };
}
