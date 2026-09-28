import { and, eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { eventOperators, eventPlans, type Db } from '@smashclub/db';
import type { SessionUser } from '../auth';

export async function isOperator(db: Db, planId: string, user: SessionUser) {
  if (user.role === 'admin') return true;
  return Boolean(
    (
      await db
        .select()
        .from(eventOperators)
        .where(and(eq(eventOperators.eventPlanId, planId), eq(eventOperators.userId, user.id)))
    )[0],
  );
}

export async function requireOperator(db: Db, planId: string, user: SessionUser) {
  if (!(await isOperator(db, planId, user)))
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You are not an organiser for this event.' });
}

export async function lockEvent(db: Db, planId: string) {
  const [plan] = await db.select().from(eventPlans).where(eq(eventPlans.id, planId)).for('update');
  if (!plan) throw new TRPCError({ code: 'NOT_FOUND', message: 'Event not found.' });
  if (plan.status === 'complete' || plan.status === 'cancelled')
    throw new TRPCError({ code: 'CONFLICT', message: 'This event is closed and read-only.' });
  return plan;
}
