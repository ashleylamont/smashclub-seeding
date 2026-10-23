import { eq, inArray } from 'drizzle-orm';
import {
  eventPlans,
  eventPlanEntries,
  eventPlanBrackets,
  eventStations,
  eventOperationSettings,
  nativeLiveHandoffs,
  nativeResultPublications,
  nativeRatingIntents,
  sets,
  type Db,
} from '@smashclub/db';
import { hash, TournamentConflict } from '../tournament/facts';
import { memberIds, type Entrant } from '../tournament/entrants';
import { BRACKET_SLOTS } from './contracts';

export type PlanRetirement = NonNullable<typeof eventPlans.$inferSelect.retirement>;

/** Idempotent projection of the retirement decision. The old journal and SQL facts remain intact. */
export async function applyPlanRetirement(
  db: Db,
  planId: string,
  retirement: PlanRetirement,
  entrants?: Entrant[],
) {
  return db.transaction(async (tx) => {
    const handoffs = await tx
      .select()
      .from(nativeLiveHandoffs)
      .where(eq(nativeLiveHandoffs.eventPlanId, planId))
      .for('update');
    const [plan] = await tx
      .select()
      .from(eventPlans)
      .where(eq(eventPlans.id, planId))
      .for('update');
    if (!plan) throw new TournamentConflict('Event not found.');
    if (plan.retirement) {
      if (hash(plan.retirement) !== hash(retirement))
        throw new TournamentConflict('This event was already retired by another request.');
      return plan.retirement;
    }
    if (retirement.replacementPlanId) {
      const id = retirement.replacementPlanId;
      await tx.insert(eventPlans).values({
        id,
        name: plan.name,
        eventDate: plan.eventDate,
        bracketMode: plan.bracketMode,
        competitionFormat: plan.competitionFormat,
        structure: plan.structure,
        structureOptions: plan.structureOptions,
        usePairRatings: plan.usePairRatings,
        poolSize: plan.poolSize,
        upperTargetSize: plan.upperTargetSize,
      });
      const rows = await tx
        .select()
        .from(eventPlanEntries)
        .where(eq(eventPlanEntries.eventPlanId, planId));
      const roster = entrants
        ? entrants.map((e, index) => {
            const members = memberIds(e);
            const original = rows.find((row) => row.id === e.id);
            return {
              eventPlanId: id,
              sourceLineNumber: index + 1,
              rawInput: original?.rawInput ?? e.name,
              cleanedName: original?.cleanedName ?? e.name,
              companyId: original?.companyId ?? null,
              divisionPreference: original?.divisionPreference ?? 'auto',
              playerId: members[0]!,
              partnerPlayerId: members[1] ?? null,
              teamName: e.teamName ?? null,
              resolutionMethod: 'manual' as const,
            };
          })
        : rows.map((e) => ({
            eventPlanId: id,
            sourceLineNumber: e.sourceLineNumber,
            rawInput: e.rawInput,
            cleanedName: e.cleanedName,
            companyId: e.companyId,
            playerId: e.playerId,
            partnerPlayerId: e.partnerPlayerId,
            teamName: e.teamName,
            resolutionMethod: e.resolutionMethod,
            divisionPreference: e.divisionPreference,
          }));
      if (roster.length) await tx.insert(eventPlanEntries).values(roster);
      await tx
        .insert(eventPlanBrackets)
        .values(BRACKET_SLOTS.map((slot) => ({ eventPlanId: id, ...slot })));
      const stations = await tx
        .select()
        .from(eventStations)
        .where(eq(eventStations.eventPlanId, planId));
      if (stations.length)
        await tx
          .insert(eventStations)
          .values(stations.map((s) => ({ eventPlanId: id, name: s.name })));
    }
    if (retirement.withdrawResults) {
      const publications = await tx
        .select()
        .from(nativeResultPublications)
        .where(eq(nativeResultPublications.eventPlanId, planId));
      const ids = publications.flatMap((p) => p.tournamentIds);
      if (ids.length)
        await tx
          .update(sets)
          .set({ excludedFromRatings: true })
          .where(inArray(sets.tournamentId, ids));
      // Reuse durable rating intents so a restart cannot lose the required recompute.
      for (const p of publications)
        await tx
          .insert(nativeRatingIntents)
          .values({ resultId: p.resultId })
          .onConflictDoUpdate({
            target: nativeRatingIntents.resultId,
            set: { completedAt: null, recomputeId: null },
          });
    }
    if (!handoffs.length)
      await tx
        .update(eventOperationSettings)
        .set({ published: false, playerReports: false })
        .where(eq(eventOperationSettings.eventPlanId, planId));
    await tx
      .update(eventPlans)
      .set({
        status: 'cancelled',
        deletedAt: new Date(retirement.at),
        resultsWithdrawnAt: retirement.withdrawResults ? new Date(retirement.at) : null,
        retirement,
        updatedAt: new Date(retirement.at),
      })
      .where(eq(eventPlans.id, planId));
    return retirement;
  });
}
