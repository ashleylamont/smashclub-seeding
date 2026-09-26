import { and, eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { eventPlanBrackets, tournaments, type Db } from '@smashclub/db';
import type { SessionUser } from '../auth';
import { ChallongeClient, type TournamentBundle } from '../challonge/client';
import { syncTournament } from '../sync/sync';
import { lockEvent, prepare, requireOperator } from './service';

interface RefreshDependencies {
  recompute: { request(): void };
  /** Test seam; production always uses the normal public-only sync pipeline. */
  sync?: typeof syncTournament;
}

interface BracketRefresh {
  tournamentId: string;
  slug: string;
  slots: Array<{ division: 'upper' | 'lower'; stage: 'main' | 'consolation' }>;
  status: 'refreshed' | 'failed';
  setsChanged: number;
  error: string | null;
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Unable to refresh this bracket.';

/**
 * One event action refreshes all attached brackets without holding the event
 * lock over network requests. Each import rechecks authorisation, lifecycle and
 * attachment under the same event lock used by scores and planner changes.
 * Failed imports roll back as a unit, preserving the last useful local state.
 */
export async function refreshEventSources(
  db: Db,
  client: ChallongeClient,
  actor: SessionUser,
  planId: string,
  dependencies: RefreshDependencies,
) {
  const linked = await db.transaction(async tx => {
    await requireOperator(tx, planId, actor);
    await lockEvent(tx, planId);
    return tx.select({
      tournamentId: tournaments.id,
      slug: tournaments.challongeSlug,
      division: eventPlanBrackets.division,
      stage: eventPlanBrackets.stage,
    }).from(eventPlanBrackets)
      .innerJoin(tournaments, eq(eventPlanBrackets.tournamentId, tournaments.id))
      .where(eq(eventPlanBrackets.eventPlanId, planId));
  });

  const unique = [...new Map(linked.map(row => [row.tournamentId, {
    tournamentId: row.tournamentId,
    slug: row.slug,
    slots: linked.filter(slot => slot.tournamentId === row.tournamentId)
      .map(({ division, stage }) => ({ division, stage })),
  }])).values()];
  const fetched = await Promise.allSettled(unique.map(bracket => client.fetchPublicTournamentBundle(bracket.slug)));
  const brackets: BracketRefresh[] = [];
  let changed = false;

  for (const [index, bracket] of unique.entries()) {
    const result = fetched[index]!;
    if (result.status === 'rejected') {
      brackets.push({ ...bracket, status: 'failed', setsChanged: 0, error: errorMessage(result.reason) });
      continue;
    }
    try {
      const imported = await db.transaction(async tx => {
        await requireOperator(tx, planId, actor);
        await lockEvent(tx, planId);
        const current = await tx.select({ slug: tournaments.challongeSlug })
          .from(eventPlanBrackets)
          .innerJoin(tournaments, eq(eventPlanBrackets.tournamentId, tournaments.id))
          .where(and(eq(eventPlanBrackets.eventPlanId, planId), eq(tournaments.id, bracket.tournamentId)));
        if (!current.some(row => row.slug === bracket.slug)) {
          throw new TRPCError({ code: 'CONFLICT', message: 'This bracket was detached or replaced during refresh. Refresh the event before trying again.' });
        }
        return (dependencies.sync ?? syncTournament)(tx, prefetchedPublicClient(bracket.slug, result.value), bracket.tournamentId, { source: 'public' });
      });
      changed ||= imported.setsChanged > 0;
      brackets.push({ ...bracket, status: 'refreshed', setsChanged: imported.setsChanged, error: null });
    } catch (error) {
      brackets.push({ ...bracket, status: 'failed', setsChanged: 0, error: errorMessage(error) });
    }
  }

  // One debounced rating request for the whole batch, and none for an unchanged
  // repeat. Local operational-only results are never silently included in ratings.
  if (changed) dependencies.recompute.request();
  let queue: { created: number | null; error: string | null } = { created: null, error: null };
  if (brackets.some(bracket => bracket.status === 'refreshed')) {
    try {
      const refreshed = await db.transaction(async tx => {
        await requireOperator(tx, planId, actor);
        await lockEvent(tx, planId);
        return prepare(tx, planId);
      });
      queue = { created: refreshed.created, error: null };
    } catch (error) {
      queue = { created: null, error: errorMessage(error) };
    }
  }
  return { brackets, queue, recomputeRequested: changed };
}

/** Nothing inside the import transaction can trigger another network call. */
function prefetchedPublicClient(slug: string, bundle: TournamentBundle): ChallongeClient {
  const cached = new ChallongeClient({
    minRequestSpacingMs: 0,
    maxRetries: 0,
    fetchImpl: async () => { throw new Error('Only the prefetched public bracket is available during event refresh.'); },
  });
  cached.fetchPublicTournamentBundle = async requestedSlug => {
    if (requestedSlug !== slug) throw new Error('Unexpected bracket requested during event refresh.');
    return bundle;
  };
  return cached;
}
