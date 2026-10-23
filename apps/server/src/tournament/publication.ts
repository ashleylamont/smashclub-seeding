import { eliminationStandings } from '@smashclub/engine';
import { memberIds } from './entrants';
import { eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  nativeLiveHandoffs,
  nativeResultPublications,
  nativeRatingIntents,
  eventPlans,
  tournaments,
  tournamentParticipants,
  sets,
  type Db,
} from '@smashclub/db';
import { hash, TournamentConflict } from './domain';
import type { TournamentResult } from './schemas';
import { runRecompute } from '../recompute/recompute';
import { historicalPlayerIds } from '../identity/playerIds';

/** Only sealed facts are exported. Profile/draw/rating reads cannot change this result. */
export async function publishNativeResult(
  db: Db,
  result: TournamentResult,
  fault?: (phase: 'beforeReceipt' | 'afterCommit', transaction?: Db) => Promise<void>,
) {
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
    const [plan] = await tx.select().from(eventPlans).where(eq(eventPlans.id, result.planId));
    // A delayed seal reaction cannot republish a retired event after recovery.
    if (plan!.deletedAt) return { resultId: result.id, tournamentIds: [] };
    const revisions = await tx
      .select()
      .from(nativeResultPublications)
      .where(eq(nativeResultPublications.eventPlanId, result.planId));
    const previous = revisions.sort((a, b) => b.revision - a.revision)[0];
    if (
      result.revision !== (previous?.revision ?? 0) + 1 ||
      result.replacesResultId !== (previous?.resultId ?? null)
    )
      throw new TournamentConflict('Replacement must supersede the latest published revision.');
    if (previous?.tournamentIds.length)
      await tx
        .update(sets)
        .set({ excludedFromRatings: true })
        .where(inArray(sets.tournamentId, previous.tournamentIds));
    const tournamentIds: string[] = [];
    const canonicalId = await historicalPlayerIds(tx);
    if (result.competitionFormat === 'doubles') {
      const members = result.entrants.flatMap((e) => memberIds(e).map(canonicalId));
      if (
        result.entrants.some((e) => memberIds(e).length !== 2) ||
        new Set(members).size !== members.length
      )
        throw new TournamentConflict(
          'Doubles member identities require review before publication.',
        );
    }
    for (const bracket of result.brackets) {
      const matches = result.matches.filter(
        (m) =>
          !m.skipped &&
          (m.bracketId === bracket.id ||
            (bracket.stage === 'main' && m.stage === 'group' && m.division === bracket.division)),
      );
      if (!matches.length && !bracket.entrantIds.length) continue;
      const slug = `nemesis_${result.planId.replaceAll('-', '')}_${bracket.division}_${bracket.stage}_r${result.revision}`;
      const [tournament] = await tx
        .insert(tournaments)
        .values({
          provider: 'native',
          competitionFormat: result.competitionFormat ?? 'singles',
          challongeSlug: slug,
          name: `${result.name} ${result.structure && result.structure !== 'dual_division' ? 'Open' : bracket.division === 'upper' ? 'Upper' : 'Lower'} ${bracket.stage === 'main' ? (result.structure === 'round_robin' ? 'Round Robin' : 'Main') : 'Consolation'}`,
          eventDate: new Date(result.eventDate),
          eventDateManual: true,
          challongeState: 'complete',
          syncState: 'synced',
          raw: {
            provider: 'native',
            eventPlanId: result.planId,
            eventName: result.name,
            resultId: result.id,
            resultRevision: result.revision,
            competitionFormat: result.competitionFormat ?? 'singles',
            structure: result.structure ?? 'dual_division',
            structureOptions: result.structureOptions,
            division: bracket.division,
            stage: bracket.stage,
            tournamentType:
              result.structure === 'round_robin'
                ? 'round robin'
                : result.structure === 'double_elimination'
                  ? 'double elimination'
                  : 'single elimination',
          },
        })
        .returning();
      tournamentIds.push(tournament!.id);
      const finals = matches.filter((m) => m.bracketId === bracket.id);
      const outcome = eliminationStandings(
        bracket.entrantIds,
        finals,
        result.structure === 'double_elimination',
      );
      const ranks = new Map(outcome.standings.map((s) => [s.playerId, s.place]));
      if (result.structure === 'round_robin')
        result.poolOrders
          ?.find((p) => p.division === bracket.division)
          ?.order.forEach((id, i) => ranks.set(id, i + 1));
      if (result.structure === 'round_robin_finals' && bracket.stage === 'main')
        result.poolOrders
          ?.find((p) => p.division === bracket.division)
          ?.order.forEach((id, i) => {
            if (!bracket.entrantIds.includes(id)) ranks.set(id, i + 1);
          });
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
            playerId: result.competitionFormat === 'doubles' ? null : canonicalId(playerId),
            teamName: result.entrants.find((e) => e.playerId === playerId)!.teamName ?? null,
            memberPlayerIds:
              result.competitionFormat === 'doubles'
                ? memberIds(result.entrants.find((e) => e.playerId === playerId)!).map(canonicalId)
                : null,
            rawName: result.entrants.find((e) => e.playerId === playerId)!.name,
            cleanedName: result.entrants.find((e) => e.playerId === playerId)!.name,
            finalRank: ranks.get(playerId) ?? null,
          })),
        )
        .returning();
      const participantIds = new Map(playerIds.map((id, i) => [id, participants[i]!.id]));
      const participant = (id: string | null) => (id ? (participantIds.get(id) ?? null) : null);
      for (const [index, match] of matches.entries())
        await tx.insert(sets).values({
          tournamentId: tournament!.id,
          challongeMatchId: index + 1,
          resultStage: match.stage === 'group' ? 'group' : 'final',
          state: 'complete',
          round:
            match.bracketLane === 'losers'
              ? -(match.bracketRound ?? match.round)
              : (match.bracketRound ?? match.round),
          identifier: match.label,
          suggestedPlayOrder: index + 1,
          p1ParticipantId: participant(match.player1Id),
          p2ParticipantId: participant(match.player2Id),
          p1PlayerId:
            result.competitionFormat !== 'doubles' && match.player1Id
              ? canonicalId(match.player1Id)
              : null,
          p2PlayerId:
            result.competitionFormat !== 'doubles' && match.player2Id
              ? canonicalId(match.player2Id)
              : null,
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
