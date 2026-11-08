import { and, eq, isNull, ne, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  eventMatches,
  eventNativeBrackets,
  eventPlanBrackets,
  eventPlans,
  type Db,
} from '@smashclub/db';
import { z } from 'zod';
import { projectMatchLabels } from '../tournament/matchNames';

const maxEntrants = 512;
const sqlPublication = z.object({
  provider: z.literal('native'),
  tournamentType: z.literal('single elimination'),
  eventPlanId: z.uuid(),
  resultId: z.undefined().optional(),
});
const entrantIds = z.array(z.uuid()).min(1).max(maxEntrants);
const otherMembership = alias(eventPlanBrackets, 'other_membership');

/** SQL-era finalization kept both directions of the published set link. Only
 * project names if the completed bracket still proves every set's position. */
export async function legacyNativeArchiveLabels(
  db: Db,
  tournament: { id: string; provider: string; challongeState: string | null; raw: unknown },
  sets: readonly { id: string; resultStage: string | null; round: number | null; raw: unknown }[],
): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  if (tournament.provider !== 'native' || tournament.challongeState !== 'complete') return labels;
  const source = sqlPublication.safeParse(tournament.raw);
  if (!source.success) return labels;
  const finals = sets.filter(({ resultStage }) => resultStage === 'final');
  if (!finals.length || finals.length >= maxEntrants) return labels;
  const bySetId = new Map(finals.map((set) => [set.id, set]));
  const planId = source.data.eventPlanId;
  const rows = await db
    .select({
      bracket: {
        id: eventNativeBrackets.id,
        entrantIds: eventNativeBrackets.entrantIds,
        division: eventNativeBrackets.division,
        stage: eventNativeBrackets.stage,
      },
      id: eventMatches.id,
      sourceSetId: eventMatches.sourceSetId,
      label: eventMatches.label,
      stage: eventMatches.stage,
      division: eventMatches.division,
      round: eventMatches.nativeRound,
      slot: eventMatches.nativeSlot,
      parent1: eventMatches.parent1MatchId,
      parent2: eventMatches.parent2MatchId,
    })
    .from(eventPlanBrackets)
    .innerJoin(eventPlans, eq(eventPlans.id, eventPlanBrackets.eventPlanId))
    .innerJoin(
      eventNativeBrackets,
      and(
        eq(eventNativeBrackets.eventPlanId, eventPlanBrackets.eventPlanId),
        eq(eventNativeBrackets.division, sql`${eventPlanBrackets.division}::text`),
        eq(eventNativeBrackets.stage, sql`${eventPlanBrackets.stage}::text`),
      ),
    )
    .innerJoin(
      eventMatches,
      and(
        eq(eventMatches.eventPlanId, eventPlanBrackets.eventPlanId),
        eq(eventMatches.nativeBracketId, eventNativeBrackets.id),
      ),
    )
    .where(
      and(
        eq(eventPlanBrackets.eventPlanId, planId),
        eq(eventPlanBrackets.tournamentId, tournament.id),
        notExists(
          db
            .select({ id: otherMembership.id })
            .from(otherMembership)
            .where(
              and(
                eq(otherMembership.eventPlanId, planId),
                eq(otherMembership.tournamentId, tournament.id),
                ne(otherMembership.id, eventPlanBrackets.id),
              ),
            ),
        ),
        eq(eventPlans.status, 'complete'),
        eq(eventPlans.bracketMode, 'native'),
        isNull(eventPlans.deletedAt),
        isNull(eventPlans.historicalAdoption),
        isNull(eventPlans.resultsWithdrawnAt),
      ),
    )
    .limit(finals.length + 1);

  if (rows.length !== finals.length) return labels;
  const bracket = rows[0]!.bracket;
  const entrants = entrantIds.safeParse(bracket.entrantIds);
  if (!entrants.success || new Set(entrants.data).size !== entrants.data.length) return labels;
  for (const row of rows) {
    const set = row.sourceSetId ? bySetId.get(row.sourceSetId) : undefined;
    const raw = set?.raw as { provider?: unknown; eventMatchId?: unknown } | null | undefined;
    if (
      row.bracket.id !== bracket.id ||
      row.stage !== bracket.stage ||
      row.division !== bracket.division ||
      !set ||
      set.round !== row.round ||
      raw?.provider !== 'native' ||
      raw.eventMatchId !== row.id
    )
      return labels;
  }

  const names = projectMatchLabels({
    brackets: [bracket],
    matches: rows.map((row) => ({
      id: row.id,
      bracketId: bracket.id,
      stage: row.stage,
      round: row.round ?? 0,
      slot: row.slot ?? -1,
      label: row.label,
    })),
  });
  if (rows.some((row) => !names.get(row.id)?.labelFromStructure)) return labels;

  // The naming helper checks every round and slot. Check both feeder edges
  // too, so a correct-looking set of coordinates cannot misname another draw.
  const positions = new Map(rows.map((row) => [`${row.round}:${row.slot}`, row.id]));
  for (const row of rows) {
    const previous = row.round! - 1;
    const slot = row.slot! * 2;
    if (
      row.parent1 !== (previous ? positions.get(`${previous}:${slot}`) : null) ||
      row.parent2 !== (previous ? positions.get(`${previous}:${slot + 1}`) : null)
    )
      return labels;
  }
  return new Map(rows.map((row) => [row.sourceSetId!, names.get(row.id)!.label]));
}
