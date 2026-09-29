import { eq } from 'drizzle-orm';
import { eventMatches, eventNativeBrackets, type Db } from '@smashclub/db';
import { isPendingSlot } from './nativeBracketSlots';

const noContest = 'Both players withdrawn: no contest; no winner or score recorded';
const resolved = (match: typeof eventMatches.$inferSelect) =>
  match.status === 'complete' || match.blockedReason === noContest;

export async function nativeBracketViews(db: Db, planId: string) {
  const brackets = await db
    .select()
    .from(eventNativeBrackets)
    .where(eq(eventNativeBrackets.eventPlanId, planId));
  const matches = await db.select().from(eventMatches).where(eq(eventMatches.eventPlanId, planId));
  return brackets.map((bracket) => {
    const rounds = matches.filter((m) => m.nativeBracketId === bracket.id);
    const maxRound = Math.max(0, ...rounds.map((m) => m.nativeRound ?? 0));
    const final = rounds.find((m) => m.nativeRound === maxRound);
    const complete =
      bracket.entrantIds.length === 0 ||
      (bracket.entrantIds.every((id) => !isPendingSlot(id)) &&
        final !== undefined &&
        resolved(final));
    const winnerId = complete ? (final?.winnerId ?? null) : null;
    const standings = !complete
      ? []
      : rounds.flatMap((m) =>
          m.outcome !== 'bye' && m.status === 'complete' && m.winnerId && m.player1Id && m.player2Id
            ? [
                {
                  playerId: m.winnerId === m.player1Id ? m.player2Id : m.player1Id,
                  place: 2 ** (maxRound - m.nativeRound!) + 1,
                },
              ]
            : [],
        );
    if (winnerId) standings.push({ playerId: winnerId, place: 1 });
    return {
      ...bracket,
      complete,
      winnerId,
      standings: standings.sort((a, b) => a.place - b.place),
    };
  });
}
