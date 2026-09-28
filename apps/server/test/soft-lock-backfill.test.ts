import { readFile } from 'node:fs/promises'
import { eq, sql } from 'drizzle-orm'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  eventMatches,
  eventPlanEntries,
  eventPlans,
  eventPoolAssignments,
  players,
  user,
  type Db,
} from '@smashclub/db'
import { createTestDb } from './helpers/testDb'

let db: Db
let close: () => Promise<void>
const correction = await readFile(
  new URL('../../../packages/db/migrations/0021_reopen_unplayed_pool_draws.sql', import.meta.url),
  'utf8',
)

beforeEach(async () => ({ db, close } = await createTestDb()))
afterEach(async () => close())

it('reopens only untouched draws that the old migration implicitly soft-locked', async () => {
  await db.insert(user).values({ id: 'to', name: 'TO', email: 'to@example.test' })
  const [player] = await db.insert(players).values({ canonicalName: 'Entrant' }).returning()
  const plans = await db
    .insert(eventPlans)
    .values([
      {
        name: 'Implicit lock',
        eventDate: new Date(),
        status: 'pools_ready',
        softLockedAt: new Date(),
      },
      {
        name: 'TO lock',
        eventDate: new Date(),
        status: 'pools_ready',
        softLockedAt: new Date(),
        softLockedBy: 'to',
      },
      { name: 'Started', eventDate: new Date(), status: 'pools_ready', softLockedAt: new Date() },
    ])
    .returning()
  for (const [index, plan] of plans.entries()) {
    await db.insert(eventPlanEntries).values({
      eventPlanId: plan.id,
      playerId: player!.id,
      sourceLineNumber: 1,
      rawInput: 'Entrant',
      cleanedName: 'Entrant',
      assignedDivision: 'upper',
      divisionSeed: 1,
    })
    await db
      .insert(eventPoolAssignments)
      .values({ eventPlanId: plan.id, playerId: player!.id, division: 'upper', poolIndex: 0 })
    await db.insert(eventMatches).values({
      eventPlanId: plan.id,
      sourceKey: `group:${index}`,
      division: 'upper',
      stage: 'group',
      poolIndex: 0,
      label: 'Pool A',
      ...(index === 2 ? { status: 'playing' as const } : {}),
    })
  }
  await db.transaction(async (tx) => {
    for (const statement of correction.split('--> statement-breakpoint'))
      if (statement.trim()) await tx.execute(sql.raw(statement))
  })
  const [implicit, explicit, started] = await Promise.all(
    plans.map(async (plan) => ({
      plan: (await db.select().from(eventPlans).where(eq(eventPlans.id, plan.id)))[0]!,
      matches: await db.select().from(eventMatches).where(eq(eventMatches.eventPlanId, plan.id)),
      assignments: await db
        .select()
        .from(eventPoolAssignments)
        .where(eq(eventPoolAssignments.eventPlanId, plan.id)),
    })),
  )
  expect(implicit!.plan.softLockedAt).toBeNull()
  expect(implicit!.matches).toHaveLength(0)
  expect(implicit!.assignments).toHaveLength(0)
  for (const preserved of [explicit!, started!]) {
    expect(preserved.plan.softLockedAt).toBeInstanceOf(Date)
    expect(preserved.matches).toHaveLength(1)
    expect(preserved.assignments).toHaveLength(1)
  }
})
