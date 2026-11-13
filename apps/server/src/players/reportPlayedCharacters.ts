import { eventPlans, playerClaims, setCharacterReports, sets, type Db } from '@smashclub/db';
import type { SetCharacterPick } from '@smashclub/shared';
import { TRPCError } from '@trpc/server';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { SessionUser } from '../auth';
import { isOperator } from '../event-operations/access';
import {
  archiveCharacterPlayers,
  archiveCharacterReferences,
  isPlayedArchiveSet,
} from '../events/archivedCharacters';
import { nativeHistory } from '../events/nativeHistory';
import { historicalPlayerIds } from '../identity/playerIds';
import type { NativeRuntime } from '../tournament/runtime';
import { nativeCharacterPlayers } from './nativeCharacterEvidence';
import { setCharacterPicksSchema, validSetCharacterParticipants } from './setCharacterPicks';

export const reportPlayedCharactersInput = z.object({
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('archive'), setId: z.uuid() }),
    z.object({ kind: z.literal('native'), planId: z.uuid(), matchId: z.uuid() }),
  ]),
  picks: setCharacterPicksSchema.unwrap(),
});

async function assertReporter(db: Db, actor: SessionUser, ids: string[], planId?: string) {
  if (actor.role === 'admin' || (planId && (await isOperator(db, planId, actor)))) return;
  const [claim] = await db
    .select({ id: playerClaims.id })
    .from(playerClaims)
    .where(
      and(
        eq(playerClaims.userId, actor.id),
        eq(playerClaims.status, 'approved'),
        inArray(playerClaims.playerId, ids),
      ),
    )
    .limit(1);
  if (!claim)
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Claim a participating player before reporting fighters for this set.',
    });
}

function unavailable(): never {
  throw new TRPCError({ code: 'NOT_FOUND', message: 'This played set is unavailable.' });
}

async function archivedTarget(db: Db, setId: string) {
  const [set] = await db.select().from(sets).where(eq(sets.id, setId)).for('share');
  if (
    !set ||
    !isPlayedArchiveSet(set) ||
    (await nativeHistory(db)).superseded.has(set.tournamentId)
  )
    unavailable();
  const { members } = await archiveCharacterPlayers(db, [set]);
  const ref = (await archiveCharacterReferences(db, [set])).get(setId);
  return {
    kind: ref ? ('native' as const) : ('archive' as const),
    matchId: ref?.matchId ?? setId,
    planId: ref?.planId,
    ids: members.get(setId)!.map(({ id }) => id),
  };
}

async function nativeTarget(
  db: Db,
  runtime: NativeRuntime | undefined,
  planId: string,
  matchId: string,
) {
  if (!runtime) unavailable();
  const [plan] = await db
    .select({
      deletedAt: eventPlans.deletedAt,
      withdrawn: eventPlans.resultsWithdrawnAt,
    })
    .from(eventPlans)
    .where(eq(eventPlans.id, planId));
  if (!plan || plan.deletedAt || plan.withdrawn) unavailable();
  const state = await runtime.state(planId);
  const match = state.matches.find(({ id }) => id === matchId);
  if (
    !state.settings.published ||
    state.lifecycle === 'cancelled' ||
    !match ||
    match.status !== 'complete' ||
    match.outcome !== 'played' ||
    match.skipped
  )
    unavailable();
  const canonical = await historicalPlayerIds(db);
  return {
    kind: 'native' as const,
    matchId,
    planId,
    ids: nativeCharacterPlayers(state.entrants, match).map(canonical),
  };
}

export async function reportPlayedCharacters(
  db: Db,
  actor: SessionUser,
  runtime: NativeRuntime | undefined,
  input: z.infer<typeof reportPlayedCharactersInput>,
) {
  return db.transaction(async (tx) => {
    const target =
      input.target.kind === 'archive'
        ? await archivedTarget(tx, input.target.setId)
        : await nativeTarget(tx, runtime, input.target.planId, input.target.matchId);
    if (target.ids.length < 2 || !validSetCharacterParticipants(input.picks, target.ids, 'played'))
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Choose fighters for players in this set.',
      });
    await assertReporter(tx, actor, target.ids, target.planId);
    const { kind, matchId, ids: participantIds } = target;
    const picks: SetCharacterPick[] = input.picks;
    await tx
      .insert(setCharacterReports)
      .values({ kind, matchId, userId: actor.id, picks, participantIds })
      .onConflictDoUpdate({
        target: [setCharacterReports.kind, setCharacterReports.matchId, setCharacterReports.userId],
        set: { picks, participantIds, updatedAt: new Date() },
      });
    return { ok: true };
  });
}
