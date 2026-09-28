import { and, eq } from 'drizzle-orm'
import { eventPlans, eventPoolSchedules, type Db, type eventMatches } from '@smashclub/db'

/** Caller holds the event lock; this policy never grants correction/forfeit authority. */
export async function canAutoAcceptPoolScore(db: Db, match: typeof eventMatches.$inferSelect) {
  if (
    match.stage !== 'group' ||
    match.status !== 'playing' ||
    match.poolIndex === null ||
    !match.stationId
  )
    return false
  const [plan] = await db.select().from(eventPlans).where(eq(eventPlans.id, match.eventPlanId))
  if (plan?.bracketMode !== 'native') return false
  const [pool] = await db
    .select()
    .from(eventPoolSchedules)
    .where(
      and(
        eq(eventPoolSchedules.eventPlanId, match.eventPlanId),
        eq(eventPoolSchedules.division, match.division),
        eq(eventPoolSchedules.poolIndex, match.poolIndex),
      ),
    )
  return Boolean(
    pool?.active &&
    pool.selfRun &&
    pool.autoAcceptScores &&
    pool.stationIds.includes(match.stationId),
  )
}
