import {
  eventOperationSettings,
  type eventPlans,
  nativeLiveHandoffs,
  type Db,
} from '@smashclub/db';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import type { TournamentState } from '../tournament/schemas';
import type { TrpcContext } from '../trpc/trpc';

type PresentationPlan = Pick<
  typeof eventPlans.$inferSelect,
  'id' | 'status' | 'bracketMode' | 'historicalAdoption'
>;

export function nativeBroadcastOpen(state: TournamentState) {
  return Boolean(
    state.baseline && (state.lifecycle === 'locked' || state.lifecycle === 'unlocked'),
  );
}

export async function readPresentationLifecycle(
  db: Db,
  plan: PresentationPlan,
  runtime: TrpcContext['nativeRuntime'],
) {
  const [handoff] = await db
    .select({ planId: nativeLiveHandoffs.eventPlanId })
    .from(nativeLiveHandoffs)
    .where(eq(nativeLiveHandoffs.eventPlanId, plan.id));
  if (handoff) {
    if (!runtime)
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'The native live event is unavailable.',
      });
    // Read the established owner without seeding a handoff or issuing an Act command.
    const state = await runtime.state(plan.id);
    return { open: nativeBroadcastOpen(state), published: state.settings.published };
  }
  if (plan.bracketMode === 'native' && !plan.historicalAdoption)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Open the event workspace to start the native event first.',
    });
  if (plan.status !== 'underway') return { open: false, published: false };

  const [settings] = await db
    .select({ published: eventOperationSettings.published })
    .from(eventOperationSettings)
    .where(eq(eventOperationSettings.eventPlanId, plan.id));
  return { open: true, published: settings?.published ?? false };
}
