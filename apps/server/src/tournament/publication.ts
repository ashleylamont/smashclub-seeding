import { eq, isNull, sql } from 'drizzle-orm';
import {
  nativeLiveHandoffs,
  nativeResultPublications,
  nativeRatingIntents,
  tournaments,
  tournamentParticipants,
  sets,
  type Db,
} from '@smashclub/db';
import { hash, TournamentConflict } from './domain';
import type { TournamentResult } from './schemas';
import { runRecompute } from '../recompute/recompute';

/** Only sealed facts are exported. Profile/draw/rating reads cannot change this result. */
export async function publishNativeResult(
  db: Db,
  result: TournamentResult,
  fault?: (phase: 'beforeReceipt' | 'afterCommit', transaction?: Db) => Promise<void>,
) {
  if (result.revision !== 1)
    throw new TournamentConflict('Replacement result publication is not implemented.');
  const publication = await db.transaction(async (tx) => {
    const [handoff] = await tx
      .select()
      .from(nativeLiveHandoffs)
      .where(eq(nativeLiveHandoffs.eventPlanId, result.planId))
      .for('update');
    if (!handoff) throw new TournamentConflict('Missing native baseline handoff.');
    const [prior] = await tx
      .select()
      .from(nativeResultPublications)
      .where(eq(nativeResultPublications.resultId, result.id));
    if (prior) {
      if (hash(prior.result) !== hash(result))
        throw new TournamentConflict('Publication receipt refers to different results.');
      return { resultId: result.id, tournamentIds: prior.tournamentIds };
    }
    const tournamentIds: string[] = [];
    for (const bracket of result.brackets) {
      const matches = result.matches.filter(
        (m) =>
          m.bracketId === bracket.id ||
          (bracket.stage === 'main' && m.stage === 'group' && m.division === bracket.division),
      );
      if (!matches.length && !bracket.entrantIds.length) continue;
      const slug = `nemesis_${result.planId.replaceAll('-', '')}_${bracket.division}_${bracket.stage}_r${result.revision}`;
      const [tournament] = await tx
        .insert(tournaments)
        .values({
          provider: 'native',
          challongeSlug: slug,
          name: `${result.name} ${bracket.division === 'upper' ? 'Upper' : 'Lower'} ${bracket.stage === 'main' ? 'Main' : 'Consolation'}`,
          eventDate: new Date(result.eventDate),
          eventDateManual: true,
          challongeState: 'complete',
          syncState: 'synced',
          raw: {
            provider: 'native',
            eventPlanId: result.planId,
            resultId: result.id,
            resultRevision: result.revision,
            tournamentType: 'single elimination',
          },
        })
        .returning();
      tournamentIds.push(tournament!.id);
      const finals = matches.filter((m) => m.bracketId === bracket.id);
      const maxRound = Math.max(0, ...finals.map((m) => m.round));
      const final = finals.find((m) => m.round === maxRound);
      const ranks = new Map<string, number>();
      for (const match of finals) {
        if (match.player1Id && match.player2Id && match.winnerId)
          ranks.set(
            match.winnerId === match.player1Id ? match.player2Id : match.player1Id,
            2 ** (maxRound - match.round) + 1,
          );
      }
      if (final?.winnerId) ranks.set(final.winnerId, 1);
      if (bracket.entrantIds.length === 1) ranks.set(bracket.entrantIds[0]!, 1);
      const playerIds = [
        ...new Set([
          ...bracket.entrantIds,
          ...matches.flatMap((m) =>
            [m.player1Id, m.player2Id].filter((id): id is string => Boolean(id)),
          ),
        ]),
      ];
      const participants = await tx
        .insert(tournamentParticipants)
        .values(
          playerIds.map((playerId, i) => ({
            tournamentId: tournament!.id,
            challongeParticipantId: i + 1,
            playerId,
            rawName: result.entrants.find((e) => e.playerId === playerId)!.name,
            cleanedName: result.entrants.find((e) => e.playerId === playerId)!.name,
            finalRank: ranks.get(playerId) ?? null,
          })),
        )
        .returning();
      const participant = (id: string | null) =>
        participants.find((p) => p.playerId === id)?.id ?? null;
      for (const [index, match] of matches.entries())
        await tx.insert(sets).values({
          tournamentId: tournament!.id,
          challongeMatchId: index + 1,
          resultStage: match.stage === 'group' ? 'group' : 'final',
          state: 'complete',
          round: match.round,
          identifier: match.label,
          suggestedPlayOrder: index + 1,
          p1ParticipantId: participant(match.player1Id),
          p2ParticipantId: participant(match.player2Id),
          p1PlayerId: match.player1Id,
          p2PlayerId: match.player2Id,
          winner: match.winnerId ? (match.winnerId === match.player1Id ? 1 : 2) : null,
          scoresCsv: match.outcome === 'played' ? `${match.score1}-${match.score2}` : null,
          excludedFromRatings: match.outcome !== 'played',
          completedAt: new Date(match.completedAt ?? result.sealedAt),
          raw: {
            provider: 'native',
            eventMatchId: match.id,
            resultId: result.id,
            resultRevision: result.revision,
            outcome: match.outcome,
          },
        });
    }
    await fault?.('beforeReceipt', tx);
    await tx.insert(nativeResultPublications).values({
      resultId: result.id,
      eventPlanId: result.planId,
      revision: result.revision,
      result,
      tournamentIds,
    });
    await tx.insert(nativeRatingIntents).values({ resultId: result.id });
    return { resultId: result.id, tournamentIds };
  });
  await fault?.('afterCommit');
  return publication;
}

/** Recoverable WHR intent. A crash after recompute permits a safe repeat, never a lost request. */
export async function processNativeRatingIntents(db: Db, recompute = runRecompute) {
  return db.transaction(async (tx) => {
    // Serialize intent workers. Recompute through this transaction so PGlite
    // cannot deadlock on an outside query, and intent acknowledgement commits
    // atomically with the successful rating run.
    await tx.execute(sql`select pg_advisory_xact_lock(782391)`);
    const pending = await tx
      .select()
      .from(nativeRatingIntents)
      .where(isNull(nativeRatingIntents.completedAt))
      .for('update');
    if (!pending.length) return 0;
    const result = await recompute(tx);
    for (const intent of pending)
      await tx
        .update(nativeRatingIntents)
        .set({ completedAt: new Date(), recomputeId: result.recomputeId })
        .where(eq(nativeRatingIntents.resultId, intent.resultId));
    return pending.length;
  });
}
