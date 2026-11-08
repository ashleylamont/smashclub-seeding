import {
  eventPlanBrackets,
  eventPlans,
  nativeResultPublications,
  tournaments,
  type Db,
} from '@smashclub/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { SessionUser } from '../auth';
import { isOperator } from './access';

export const resultGraphicScope = z.union([
  z.object({ planId: z.uuid() }),
  z.object({ tournamentIds: z.array(z.uuid()).min(1).max(4) }),
]);

/** This capability only enables local artwork choices in the export preview. */
export async function canCustomizeResultGraphic(
  db: Db,
  user: SessionUser,
  scope: z.infer<typeof resultGraphicScope>,
): Promise<boolean> {
  if ('planId' in scope) return canCustomizeForPlan(db, user, scope.planId);

  const ids = [...new Set(scope.tournamentIds)];
  const existing = await db
    .select({ id: tournaments.id })
    .from(tournaments)
    .where(inArray(tournaments.id, ids));
  if (existing.length !== ids.length) return false;
  if (user.role === 'admin') return true;

  const [linked, native] = await Promise.all([
    db
      .select({ planId: eventPlanBrackets.eventPlanId, id: eventPlanBrackets.tournamentId })
      .from(eventPlanBrackets)
      .where(inArray(eventPlanBrackets.tournamentId, ids)),
    db
      .select({
        planId: nativeResultPublications.eventPlanId,
        ids: nativeResultPublications.tournamentIds,
      })
      .from(nativeResultPublications)
      .where(
        sql`${nativeResultPublications.tournamentIds} ?| ARRAY[${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )}]::text[]`,
      ),
  ]);
  const sources = new Map(ids.map((id) => [id, new Set<string>()]));
  for (const link of linked) sources.get(link.id!)?.add(link.planId);
  for (const receipt of native) for (const id of receipt.ids) sources.get(id)?.add(receipt.planId);

  if ([...sources.values()].some((plans) => plans.size !== 1)) return false;
  const planIds = new Set([...sources.values()].flatMap((plans) => [...plans]));
  const [planId] = planIds;
  return planIds.size === 1 && canCustomizeForPlan(db, user, planId!);
}

async function canCustomizeForPlan(db: Db, user: SessionUser, planId: string) {
  const [plan] = await db
    .select({ id: eventPlans.id })
    .from(eventPlans)
    .where(and(eq(eventPlans.id, planId), isNull(eventPlans.deletedAt)));
  return Boolean(plan) && isOperator(db, planId, user);
}
