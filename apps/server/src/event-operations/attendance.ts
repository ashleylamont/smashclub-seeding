import { createHash } from 'node:crypto'
import { and, eq, or } from 'drizzle-orm'
import { TRPCError } from '@trpc/server'
import {
  eventAttendanceAudit,
  eventMatchAudit,
  eventNativeBrackets,
  eventMatches,
  eventPlanBrackets,
  eventPlanEntries,
  eventPlanPoolPlacements,
  eventPoolSchedules,
  eventPlans,
  eventPoolAssignments,
  eventScoreReports,
  eventWithdrawals,
  players,
  type Db,
} from '@smashclub/db'
import type { SessionUser } from '../auth'
import { getPlan } from '../event-planner/plans'
import { advanceNativeBrackets } from './nativeBrackets'
import { lockEvent, prepare, requireOperator } from './service'
export interface AttendanceInput {
  planId: string
  action: 'add' | 'withdraw' | 'no_show' | 'redistribute'
  playerId: string
  division?: 'upper' | 'lower'
  poolIndex?: number
  reason?: string
  acknowledgeExternalChange?: boolean
  approveRedistribution?: boolean
}
/** Commit the current draw before admitting small, local attendance changes. */
export async function softLockPools(db: Db, actor: SessionUser, planId: string) {
  return db.transaction(async (tx) => {
    const plan = await lockEvent(tx, planId)
    await requireOperator(tx, planId, actor)
    if (plan.softLockedAt) return { softLockedAt: plan.softLockedAt.toISOString() }
    if (plan.status !== 'pools_ready')
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Generate pools before soft-locking the draw.',
      })
    const view = (await getPlan(tx, planId))!
    if (
      view.divisions.some(
        (d) => !d.pools.length || d.pools.some((p) => p.members.length < 3 || p.members.length > 5),
      ) ||
      view.divisions.reduce((count, d) => count + d.size, 0) !== view.entries.length
    )
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Resolve the roster and generate valid pools before soft-locking.',
      })
    const assignments = view.divisions.flatMap((d) =>
      d.pools.flatMap((p) =>
        p.members.map((m) => ({
          eventPlanId: planId,
          division: d.division,
          poolIndex: p.poolIndex,
          playerId: m.playerId,
        })),
      ),
    )
    const stored = await tx
      .select()
      .from(eventPoolAssignments)
      .where(eq(eventPoolAssignments.eventPlanId, planId))
    if (!stored.length) await tx.insert(eventPoolAssignments).values(assignments)
    else if (
      stored.length !== assignments.length ||
      assignments.some(
        (a) =>
          !stored.some(
            (s) =>
              s.division === a.division && s.poolIndex === a.poolIndex && s.playerId === a.playerId,
          ),
      )
    )
      throw new TRPCError({
        code: 'CONFLICT',
        message:
          'Saved pool assignments differ from the current draw. Reconcile them before soft-locking.',
      })
    const now = new Date()
    await tx
      .update(eventPlans)
      .set({ softLockedAt: now, softLockedBy: actor.id, updatedAt: now })
      .where(eq(eventPlans.id, planId))
    await prepare(tx, planId)
    await tx.insert(eventAttendanceAudit).values({
      eventPlanId: planId,
      userId: actor.id,
      action: 'soft_lock',
      details: {
        assignments: assignments.map((a) => ({
          division: a.division,
          poolIndex: a.poolIndex,
          playerId: a.playerId,
        })),
      },
    })
    return { softLockedAt: now.toISOString() }
  })
}
export async function previewAttendance(db: Db, input: AttendanceInput) {
  const view = await getPlan(db, input.planId)
  if (!view) throw new TRPCError({ code: 'NOT_FOUND', message: 'Event not found.' })
  const matches = await db
    .select()
    .from(eventMatches)
    .where(eq(eventMatches.eventPlanId, input.planId))
  const reports = await db
    .select({ matchId: eventScoreReports.matchId })
    .from(eventScoreReports)
    .where(eq(eventScoreReports.eventPlanId, input.planId))
  const audits = await db
    .select({ matchId: eventMatchAudit.matchId })
    .from(eventMatchAudit)
    .where(eq(eventMatchAudit.eventPlanId, input.planId))
  const schedules = await db
    .select()
    .from(eventPoolSchedules)
    .where(eq(eventPoolSchedules.eventPlanId, input.planId))
  const withdrawals = await db
    .select()
    .from(eventWithdrawals)
    .where(eq(eventWithdrawals.eventPlanId, input.planId))
  const [player] = await db.select().from(players).where(eq(players.id, input.playerId))
  const entrant = view.entries.find((e) => e.playerId === input.playerId)
  const division = input.action === 'add' ? input.division : entrant?.assignedDivision
  const divisionPools = view.divisions.find((d) => d.division === division)?.pools ?? []
  const activeMembers = (members: (typeof divisionPools)[number]['members']) =>
    members.filter((m) => !withdrawals.some((w) => w.playerId === m.playerId))
  const isOpen = (pool: (typeof divisionPools)[number]) => {
    const schedule = schedules.find(
      (s) => s.division === division && s.poolIndex === pool.poolIndex,
    )
    const games = matches.filter(
      (m) => m.stage === 'group' && m.division === division && m.poolIndex === pool.poolIndex,
    )
    return (
      schedule?.active !== false &&
      !pool.members.some((m) => m.place !== null) &&
      !games.some(
        (m) =>
          m.status === 'playing' ||
          m.status === 'complete' ||
          m.score1 !== null ||
          m.score2 !== null ||
          m.liveScore1 !== null ||
          m.liveScore2 !== null,
      )
    )
  }
  const openPools = divisionPools
    .filter((p) => isOpen(p) && activeMembers(p.members).length < 5)
    .sort(
      (a, b) =>
        activeMembers(a.members).length - activeMembers(b.members).length ||
        a.poolIndex - b.poolIndex,
    )
  const pool =
    input.action === 'add'
      ? openPools[0]
      : divisionPools.find((p) => p.members.some((m) => m.playerId === input.playerId))
  const issues: string[] = []
  const warnings: string[] = []
  if (!['pools_ready', 'underway'].includes(view.plan.status))
    issues.push('Attendance changes require prepared pools in an open event.')
  if (!view.plan.softLockedAt)
    issues.push(
      'Soft-lock the pools first. While the draw is in draft, edit the roster and rebalance it in the planner.',
    )
  if (!player || player.status !== 'active') issues.push('Choose an existing active player.')
  if (
    input.action !== 'withdraw' &&
    (
      await db
        .select()
        .from(eventNativeBrackets)
        .where(eq(eventNativeBrackets.eventPlanId, input.planId))
    ).length
  )
    issues.push(
      'Native finals already use the roster. Remove unplayed finals before changing the pool draw.',
    )
  if (input.action === 'add' && entrant) issues.push('This player is already in the event.')
  if (input.action !== 'add' && !entrant) issues.push('This player is not an event entrant.')
  if (withdrawals.some((w) => w.playerId === input.playerId))
    issues.push('This player has already withdrawn.')
  if (!pool)
    issues.push(
      input.action === 'add'
        ? 'No open pool has room in this division.'
        : 'This player is not assigned to a pool.',
    )
  if (
    input.action === 'add' &&
    input.poolIndex !== undefined &&
    pool &&
    input.poolIndex !== pool.poolIndex
  )
    issues.push('The smallest open pool changed. Review the automatic placement.')
  const activePoolMembers =
    pool?.members.filter((m) => !withdrawals.some((w) => w.playerId === m.playerId)) ?? []
  if (input.action === 'add' && activePoolMembers.length >= 5)
    issues.push('A pool can contain at most five active entrants.')
  const relocations: { playerId: string; fromPoolIndex: number; toPoolIndex: number }[] = []
  if ((input.action === 'no_show' || input.action === 'redistribute') && pool) {
    const affectedPoolMatches = matches.filter(
      (m) => m.stage === 'group' && m.division === division && m.poolIndex === pool.poolIndex,
    )
    if (
      matches.some(
        (m) =>
          m.stage !== 'group' && (m.player1Id === input.playerId || m.player2Id === input.playerId),
      )
    )
      issues.push('Finals already include this player. Reconcile the bracket before removing them.')
    if (
      input.action === 'no_show' &&
      affectedPoolMatches.some(
        (m) =>
          (m.player1Id === input.playerId || m.player2Id === input.playerId) &&
          (m.status === 'playing' ||
            m.status === 'complete' ||
            m.score1 !== null ||
            m.score2 !== null ||
            m.liveScore1 !== null ||
            m.liveScore2 !== null),
      )
    )
      issues.push('This player has already played or started a match. Record a withdrawal instead.')
    if (
      input.action === 'no_show' &&
      affectedPoolMatches.some(
        (m) =>
          (m.player1Id === input.playerId || m.player2Id === input.playerId) &&
          reports.some((r) => r.matchId === m.id),
      )
    )
      issues.push('A score report exists for this player. Review it before removing their matches.')
    if (
      input.action === 'no_show' &&
      affectedPoolMatches.some(
        (m) =>
          (m.player1Id === input.playerId || m.player2Id === input.playerId) &&
          audits.some((a) => a.matchId === m.id),
      )
    )
      issues.push('This player has match history. Record a withdrawal instead.')
    const remaining =
      input.action === 'no_show'
        ? activePoolMembers.filter((m) => m.playerId !== input.playerId)
        : activePoolMembers
    if (input.action === 'no_show' && remaining.length < 2)
      issues.push('Removing this player would leave fewer than two active players in the pool.')
    if (input.action === 'redistribute' && remaining.length !== 2)
      issues.push('Only a two-player pool can be redistributed.')
    if (remaining.length === 2) {
      const unsafe =
        pool.members.some((m) => m.withdrawn && m.playerId !== input.playerId) ||
        affectedPoolMatches.some(
          (m) =>
            m.status === 'playing' ||
            m.status === 'complete' ||
            m.score1 !== null ||
            m.score2 !== null ||
            m.liveScore1 !== null ||
            m.liveScore2 !== null ||
            reports.some((r) => r.matchId === m.id) ||
            audits.some((a) => a.matchId === m.id),
        )
      if (unsafe && input.action === 'redistribute')
        issues.push(
          'This pool has existing results, reports, or withdrawals. Reconcile those matches before redistributing its players.',
        )
      const targets = openPools.filter((p) => p.poolIndex !== pool.poolIndex)
      const together = targets.find((p) => activeMembers(p.members).length <= 3)
      const destinations = together
        ? [together, together]
        : targets.filter((p) => activeMembers(p.members).length <= 4).slice(0, 2)
      if (destinations.length !== 2 && input.action === 'redistribute')
        issues.push('No open pools in this division have room for both remaining players.')
      else if (!unsafe && destinations.length === 2)
        remaining.forEach((member, index) =>
          relocations.push({
            playerId: member.playerId,
            fromPoolIndex: pool.poolIndex,
            toPoolIndex: destinations[index]!.poolIndex,
          }),
        )
      if (input.action === 'no_show')
        warnings.push(
          relocations.length
            ? 'This no-show would leave a two-player pool. A TO may approve the shown moves now or redistribute the pool later.'
            : 'This no-show would leave a two-player pool. The pool will stay in place until a TO can approve a safe redistribution.',
        )
    }
  }
  const attached = view.brackets.filter(
    (b) => b.division === division && (b.challongeSlug || b.tournamentId),
  )
  if (
    input.action === 'add' &&
    (attached.some((b) => b.stage === 'consolation') ||
      matches.some(
        (m) =>
          m.division === division &&
          m.stage !== 'group' &&
          (m.status === 'playing' || m.status === 'complete'),
      ))
  )
    issues.push(
      'Finals have been handed off or started. Additions require an organiser to reconcile that bracket first.',
    )
  if (attached.length)
    warnings.push(
      'This event has a linked Challonge bracket. Update its roster or withdrawal there manually and sync it; Nemesis does not change the remote bracket.',
    )
  if (input.action === 'withdraw')
    warnings.push(
      'Completed results stay recorded. Outstanding matches are held for explicit forfeit decisions. Reconfirm the pool order afterwards: the upper half of active entrants, rounded up, advance to championship.',
    )
  if (input.action === 'no_show')
    warnings.push(
      'The no-show and their unplayed pool matches will be removed. Other pools keep their existing players and matches.',
    )
  if (pool?.members.some((m) => m.place !== null))
    warnings.push('Confirmed placements for this pool will be cleared and need reconfirmation.')
  const affected =
    (input.action === 'redistribute' ||
      (input.action === 'no_show' && input.approveRedistribution)) &&
    relocations.length &&
    pool
      ? matches.filter(
          (m) => m.stage === 'group' && m.division === division && m.poolIndex === pool.poolIndex,
        )
      : matches.filter((m) => m.player1Id === input.playerId || m.player2Id === input.playerId)
  const revisionToken = createHash('sha256')
    .update(
      JSON.stringify({
        schedules: schedules
          .map((s) => [s.id, s.revision, s.active, s.stationIds])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        status: view.plan.status,
        softLockedAt: view.plan.softLockedAt,
        entries: view.entries.map((e) => [e.id, e.playerId, e.assignedDivision, e.divisionSeed]),
        pools: view.divisions.map((d) =>
          d.pools.map((p) => p.members.map((m) => [m.playerId, m.place])),
        ),
        matches: matches
          .map((m) => [m.id, m.revision, m.status])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        reports: reports.map((r) => r.matchId).sort(),
        audits: audits.map((a) => a.matchId).sort(),
        brackets: view.brackets.map((b) => [b.tournamentId, b.challongeSlug]),
        withdrawals: withdrawals.map((w) => w.playerId).sort(),
      }),
    )
    .digest('hex')
  return {
    allowed: issues.length === 0,
    issues,
    warnings,
    requiresExternalAcknowledgement: attached.length > 0,
    requiresRedistributionApproval: relocations.length > 0,
    relocations,
    division: division ?? null,
    poolIndex: pool?.poolIndex ?? null,
    poolSize: activePoolMembers.length,
    addedMatches: input.action === 'add' ? activePoolMembers.length : 0,
    affectedMatches: affected.map((m) => ({ id: m.id, label: m.label, status: m.status })),
    revisionToken,
  }
}
export async function applyAttendance(
  db: Db,
  actor: SessionUser,
  input: AttendanceInput & {
    revisionToken: string
  },
) {
  return db.transaction(async (tx) => {
    await lockEvent(tx, input.planId)
    await requireOperator(tx, input.planId, actor)
    const preview = await previewAttendance(tx, input)
    if (preview.revisionToken !== input.revisionToken)
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'The event changed since this preview. Review the updated attendance change.',
      })
    if (!preview.allowed)
      throw new TRPCError({ code: 'BAD_REQUEST', message: preview.issues.join(' ') })
    if (preview.requiresExternalAcknowledgement && !input.acknowledgeExternalChange)
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Acknowledge the manual Challonge roster update before applying this change.',
      })
    if (input.action === 'redistribute' && !input.approveRedistribution)
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'A TO must approve the proposed two-player pool redistribution.',
      })
    const view = (await getPlan(tx, input.planId))!
    const division = preview.division!
    const poolIndex = preview.poolIndex!
    // First change snapshots every current assignment. Subsequent changes extend it.
    const stored = await tx
      .select()
      .from(eventPoolAssignments)
      .where(eq(eventPoolAssignments.eventPlanId, input.planId))
    if (!stored.length)
      await tx.insert(eventPoolAssignments).values(
        view.divisions.flatMap((d) =>
          d.pools.flatMap((p) =>
            p.members.map((m) => ({
              eventPlanId: input.planId,
              division: d.division,
              poolIndex: p.poolIndex,
              playerId: m.playerId,
            })),
          ),
        ),
      )
    if (input.action === 'add') {
      const [player] = await tx.select().from(players).where(eq(players.id, input.playerId))
      const seed =
        Math.max(
          0,
          ...view.entries
            .filter((e) => e.assignedDivision === division)
            .map((e) => e.divisionSeed ?? 0),
        ) + 1
      const line = Math.max(0, ...view.entries.map((e) => e.sourceLineNumber)) + 1
      await tx.insert(eventPlanEntries).values({
        eventPlanId: input.planId,
        playerId: input.playerId,
        sourceLineNumber: line,
        rawInput: player!.canonicalName,
        cleanedName: player!.canonicalName,
        resolutionMethod: 'manual',
        divisionPreference: division,
        assignedDivision: division,
        divisionSeed: seed,
      })
      await tx
        .insert(eventPoolAssignments)
        .values({ eventPlanId: input.planId, playerId: input.playerId, division, poolIndex })
      await prepare(tx, input.planId)
    } else if (input.action === 'no_show' || input.action === 'redistribute') {
      const sourceMatches = await tx
        .select()
        .from(eventMatches)
        .where(
          and(
            eq(eventMatches.eventPlanId, input.planId),
            eq(eventMatches.division, division),
            eq(eventMatches.stage, 'group'),
            eq(eventMatches.poolIndex, poolIndex),
          ),
        )
      const actualRelocations = input.approveRedistribution ? preview.relocations : []
      const removed = actualRelocations.length
        ? sourceMatches
        : sourceMatches.filter(
            (m) => m.player1Id === input.playerId || m.player2Id === input.playerId,
          )
      for (const match of removed)
        await tx.delete(eventMatches).where(eq(eventMatches.id, match.id))
      if (input.action === 'no_show') {
        await tx
          .delete(eventPoolAssignments)
          .where(
            and(
              eq(eventPoolAssignments.eventPlanId, input.planId),
              eq(eventPoolAssignments.playerId, input.playerId),
            ),
          )
        await tx
          .delete(eventPlanEntries)
          .where(
            and(
              eq(eventPlanEntries.eventPlanId, input.planId),
              eq(eventPlanEntries.playerId, input.playerId),
            ),
          )
      }
      for (const move of actualRelocations)
        await tx
          .update(eventPoolAssignments)
          .set({ poolIndex: move.toPoolIndex })
          .where(
            and(
              eq(eventPoolAssignments.eventPlanId, input.planId),
              eq(eventPoolAssignments.playerId, move.playerId),
            ),
          )
      if (actualRelocations.length)
        await tx
          .delete(eventPoolSchedules)
          .where(
            and(
              eq(eventPoolSchedules.eventPlanId, input.planId),
              eq(eventPoolSchedules.division, division),
              eq(eventPoolSchedules.poolIndex, poolIndex),
            ),
          )
      for (const changedPool of new Set([
        poolIndex,
        ...actualRelocations.map((move) => move.toPoolIndex),
      ]))
        await tx
          .delete(eventPlanPoolPlacements)
          .where(
            and(
              eq(eventPlanPoolPlacements.eventPlanId, input.planId),
              eq(eventPlanPoolPlacements.division, division),
              eq(eventPlanPoolPlacements.poolIndex, changedPool),
            ),
          )
      await prepare(tx, input.planId)
    } else {
      const reason = input.reason?.trim() || 'Withdrawn from event'
      await tx
        .insert(eventWithdrawals)
        .values({ eventPlanId: input.planId, playerId: input.playerId, reason })
      const affected = await tx
        .select()
        .from(eventMatches)
        .where(
          and(
            eq(eventMatches.eventPlanId, input.planId),
            or(
              eq(eventMatches.player1Id, input.playerId),
              eq(eventMatches.player2Id, input.playerId),
            ),
          ),
        )
      const withdrawnIds = new Set(
        (
          await tx
            .select()
            .from(eventWithdrawals)
            .where(eq(eventWithdrawals.eventPlanId, input.planId))
        ).map((w) => w.playerId),
      )
      for (const match of affected.filter((m) => m.status !== 'complete'))
        await tx
          .update(eventMatches)
          .set({
            status: 'blocked',
            blockedReason:
              match.player1Id &&
              match.player2Id &&
              withdrawnIds.has(match.player1Id) &&
              withdrawnIds.has(match.player2Id)
                ? 'Both players withdrawn: no contest; no winner or score recorded'
                : 'Player withdrawn: awaiting organiser forfeit decision',
            revision: match.revision + 1,
          })
          .where(eq(eventMatches.id, match.id))
    }
    await advanceNativeBrackets(tx, input.planId)
    await tx
      .delete(eventPlanPoolPlacements)
      .where(
        and(
          eq(eventPlanPoolPlacements.eventPlanId, input.planId),
          eq(eventPlanPoolPlacements.division, division),
          eq(eventPlanPoolPlacements.poolIndex, poolIndex),
        ),
      )
    await tx.insert(eventAttendanceAudit).values({
      eventPlanId: input.planId,
      userId: actor.id,
      action: input.action,
      details: {
        playerId: input.playerId,
        division,
        poolIndex,
        reason: input.reason?.trim() || (input.action === 'no_show' ? 'No-show' : null),
        externalAcknowledged: input.acknowledgeExternalChange ?? false,
        redistributionApproved: input.approveRedistribution ?? false,
        relocations: input.approveRedistribution ? preview.relocations : [],
        proposedRelocations: preview.relocations,
        affectedMatches: preview.affectedMatches,
      },
    })
    await tx
      .update(eventPlans)
      .set({ updatedAt: new Date() })
      .where(eq(eventPlans.id, input.planId))
    return {
      applied: true,
      addedMatches: preview.addedMatches,
      affectedMatches: preview.affectedMatches.length,
    }
  })
}
export async function resetOperations(db: Db, actor: SessionUser, planId: string) {
  return db.transaction(async (tx) => {
    await lockEvent(tx, planId)
    await requireOperator(tx, planId, actor)
    const matches = await tx.select().from(eventMatches).where(eq(eventMatches.eventPlanId, planId))
    const reports = await tx
      .select()
      .from(eventScoreReports)
      .where(eq(eventScoreReports.eventPlanId, planId))
      .limit(1)
    const brackets = await tx
      .select()
      .from(eventPlanBrackets)
      .where(eq(eventPlanBrackets.eventPlanId, planId))
    const withdrawals = await tx
      .select()
      .from(eventWithdrawals)
      .where(eq(eventWithdrawals.eventPlanId, planId))
    if (
      matches.some(
        (m) =>
          m.status === 'playing' ||
          m.status === 'complete' ||
          m.score1 !== null ||
          m.score2 !== null ||
          m.liveScore1 !== null ||
          m.liveScore2 !== null,
      ) ||
      reports.length ||
      withdrawals.length ||
      brackets.some((b) => b.tournamentId || b.challongeSlug)
    )
      throw new TRPCError({
        code: 'CONFLICT',
        message:
          'Only an unplayed queue with no reports, withdrawals, or linked brackets can be reset.',
      })
    await tx.delete(eventMatches).where(eq(eventMatches.eventPlanId, planId))
    const [plan] = await tx.select().from(eventPlans).where(eq(eventPlans.id, planId))
    if (!plan?.softLockedAt)
      await tx.delete(eventPoolAssignments).where(eq(eventPoolAssignments.eventPlanId, planId))
    await tx.delete(eventPoolSchedules).where(eq(eventPoolSchedules.eventPlanId, planId))
    await tx.delete(eventPlanPoolPlacements).where(eq(eventPlanPoolPlacements.eventPlanId, planId))
    await tx.insert(eventAttendanceAudit).values({
      eventPlanId: planId,
      userId: actor.id,
      action: 'reset_queue',
      details: { removedMatches: matches.length },
    })
    return { removedMatches: matches.length }
  })
}
