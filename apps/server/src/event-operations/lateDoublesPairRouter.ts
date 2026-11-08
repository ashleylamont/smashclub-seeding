import { z } from 'zod';
import { players, type Db } from '@smashclub/db';
import { publicPlayerName } from '@smashclub/shared';
import { lockPlayerRows, playerIdResolver } from '../identity/playerIds';
import { authedProcedure } from '../trpc/trpc';
import { LateDoublesPairInput } from '../tournament/commands';
import { nativeTransport } from '../tournament/api';
import { hash } from '../tournament/facts';
import { reviewLateDoublesPair, type LateDoublesPair } from '../tournament/lateDoublesPair';
import { reviewedAttendanceState } from './reviewedAttendance';

async function capturePair(db: Db, ids: [string, string]): Promise<LateDoublesPair['identity']> {
  const profiles = await db
    .select({
      id: players.id,
      canonicalName: players.canonicalName,
      displayName: players.displayName,
      status: players.status,
      mergedIntoPlayerId: players.mergedIntoPlayerId,
    })
    .from(players);
  const [first, second] = ids.map((id) => profiles.find((profile) => profile.id === id));
  if (
    first?.status !== 'active' ||
    second?.status !== 'active' ||
    first.mergedIntoPlayerId ||
    second.mergedIntoPlayerId
  )
    return null;
  const canonical = playerIdResolver(profiles);
  return {
    name: `${first.canonicalName} / ${second.canonicalName}`,
    memberNames: [publicPlayerName(first), publicPlayerName(second)],
    memberAliases: profiles
      .filter(({ id, mergedIntoPlayerId }) => mergedIntoPlayerId && ids.includes(canonical(id)))
      .map(({ id }) => id)
      .sort(),
  };
}

export const previewLateDoublesPair = authedProcedure
  .input(LateDoublesPairInput.extend({ planId: z.uuid() }))
  .query(async ({ ctx, input: { planId, ...input } }) => {
    const { state } = await reviewedAttendanceState(ctx, planId, 'Late pair admissions');
    const identity = await capturePair(ctx.db, input.memberPlayerIds);
    const { pool, ...preview } = reviewLateDoublesPair(state, { ...input, identity });
    return {
      ...preview,
      poolIndex: pool?.index ?? null,
      division: input.division,
      memberNames: identity?.memberNames ?? null,
    };
  });

export const applyLateDoublesPair = authedProcedure
  .input(
    LateDoublesPairInput.extend({
      planId: z.uuid(),
      requestId: z.string().min(1).max(128),
      revisionToken: z.string().length(64),
    }),
  )
  .mutation(async ({ ctx, input: { planId, requestId, ...change } }) => {
    const { runtime } = await reviewedAttendanceState(ctx, planId, 'Late pair admissions');
    const intent = { ...change, kind: 'addLateDoublesPair' as const };
    return ctx.db.transaction(async (tx) => {
      await lockPlayerRows(tx, change.memberPlayerIds);
      const identity = await capturePair(tx, change.memberPlayerIds);
      const { receipt } = await nativeTransport(() =>
        runtime.command(ctx.user, planId, requestId, { ...intent, identity }, hash(intent), tx),
      );
      return { applied: true as const, sequence: receipt.sequence };
    });
  });
