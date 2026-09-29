import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { eventMatches, eventNativeBrackets, type Db } from '@smashclub/db';
import { standardBracketOrder } from '../event-planner/advancement';
import { getPlan } from '../event-planner/plans';

export function reject(message: string): never {
  throw new TRPCError({ code: 'CONFLICT', message });
}
export const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const pendingSlot = (division: string, poolIndex: number, place: number) =>
  `pending:${division}:${poolIndex}:${place}`;
export const isPendingSlot = (id: string | null | undefined) => Boolean(id?.startsWith('pending:'));

export function nativeDraw(entrantIds: readonly string[]) {
  if (new Set(entrantIds).size !== entrantIds.length)
    reject('A native bracket cannot contain the same entrant twice.');
  let size = 2;
  while (size < entrantIds.length) size *= 2;
  return entrantIds.length
    ? standardBracketOrder(size).map((seed) => entrantIds[seed - 1] ?? null)
    : [];
}

export function pairSlots(slots: (string | null)[]) {
  return Array.from({ length: slots.length / 2 }, (_, i) => ({
    player1Id: slots[i * 2]!,
    player2Id: slots[i * 2 + 1]!,
  }));
}

/** Fill reserved seeds after one pool confirms its finishing order, without redrawing played finals. */
export async function fillNativeBracketSlots(
  db: Db,
  planId: string,
  division: 'upper' | 'lower',
  poolIndex: number,
) {
  const view = await getPlan(db, planId);
  const pool = view?.divisions
    .find((entry) => entry.division === division)
    ?.pools.find((entry) => entry.poolIndex === poolIndex);
  if (!pool || pool.members.some((member) => member.place === null))
    reject('Confirm the full pool order before filling finals slots.');
  const active = pool.members
    .filter((member) => !member.withdrawn)
    .sort((a, b) => a.place! - b.place!);
  const replacements = new Map(
    active.map((member, index) => [pendingSlot(division, poolIndex, index + 1), member.playerId]),
  );
  const brackets = await db
    .select()
    .from(eventNativeBrackets)
    .where(
      and(eq(eventNativeBrackets.eventPlanId, planId), eq(eventNativeBrackets.division, division)),
    );
  for (const bracket of brackets) {
    const pending = bracket.entrantIds.filter((id) =>
      id.startsWith(`pending:${division}:${poolIndex}:`),
    );
    if (pending.some((id) => !replacements.has(id)))
      reject('The pool roster changed after finals were drawn. Remove unplayed finals to redraw.');
    if (!pending.length) continue;
    const entrantIds = bracket.entrantIds.map((id) => replacements.get(id) ?? id);
    const slots = nativeDraw(entrantIds);
    const firstRound = await db
      .select()
      .from(eventMatches)
      .where(and(eq(eventMatches.nativeBracketId, bracket.id), eq(eventMatches.nativeRound, 1)));
    for (const match of firstRound) {
      const first = slots[match.nativeSlot! * 2] ?? null;
      const second = slots[match.nativeSlot! * 2 + 1] ?? null;
      const p1 = isPendingSlot(first) ? null : first;
      const p2 = isPendingSlot(second) ? null : second;
      if (p1 === match.player1Id && p2 === match.player2Id) continue;
      if (match.status === 'playing' || (match.status === 'complete' && match.outcome !== 'bye'))
        reject('A finals match has started in a slot whose qualifier changed.');
      const pendingOpponent = isPendingSlot(first) || isPendingSlot(second);
      const bye = !pendingOpponent && Boolean(p1) !== Boolean(p2);
      await db
        .update(eventMatches)
        .set({
          player1Id: p1,
          player2Id: p2,
          status: bye ? 'complete' : p1 && p2 ? 'ready' : 'blocked',
          outcome: bye ? 'bye' : null,
          winnerId: bye ? (p1 ?? p2) : null,
          blockedReason: pendingOpponent ? 'Waiting for pool finishing order' : null,
          revision: match.revision + 1,
        })
        .where(eq(eventMatches.id, match.id));
    }
    await db
      .update(eventNativeBrackets)
      .set({ entrantIds })
      .where(eq(eventNativeBrackets.id, bracket.id));
  }
  const { advanceNativeBrackets } = await import('./nativeBrackets');
  await advanceNativeBrackets(db, planId);
}
