import { eq } from 'drizzle-orm';
import { eventOperationSettings, eventPlanBrackets, players, sets, tournamentParticipants, tournaments, user, type Db } from '@smashclub/db';
import { closePlan, createPlan, freezeRoster, generatePools, getPlan } from '../event-planner/plans';

/** Synthetic, completed night whose played roster differs from its saved plan. Dev harness only. */
export async function seedHistoricalEvent(db: Db): Promise<string> {
  const [admin] = await db.select().from(user).where(eq(user.email, 'admin@smashclub.dev'));
  const roster = (await db.select().from(players)).filter(player => player.status === 'active').slice(0, 9);
  if (!admin || roster.length < 9) throw new Error('Historical rehearsal needs its development accounts and players.');
  const planId = await createPlan(db, {
    name: 'Nemesis · Historical Rehearsal', eventDate: new Date('2026-08-25T08:30:00Z'), upperTargetSize: 4,
    rows: roster.slice(0, 8).map((player, index) => ({ lineNumber: index + 1, rawInput: player.canonicalName,
      cleanedName: player.canonicalName, companyId: player.companyId, playerId: player.id,
      resolutionMethod: 'manual', divisionPreference: 'auto' })),
  }, admin.id);
  await freezeRoster(db, planId);
  await generatePools(db, planId);
  const plan = (await getPlan(db, planId))!;
  const upper = plan.entries.filter(entry => entry.assignedDivision === 'upper').map(entry => entry.playerId!);
  const lower = plan.entries.filter(entry => entry.assignedDivision === 'lower').map(entry => entry.playerId!);
  // One late entrant, one absence, and a player moving in each direction.
  const actual = {
    upper: [upper[0]!, upper[1]!, lower[2]!, roster[8]!.id],
    lower: [lower[0]!, lower[1]!, upper[2]!, lower[3]!],
  };
  const playerById = new Map(roster.map(player => [player.id, player]));
  for (const division of ['upper', 'lower'] as const) {
    for (const stage of ['main', 'consolation'] as const) {
      const slug = `historical_rehearsal_${division}_${stage}`;
      const [tournament] = await db.insert(tournaments).values({
        challongeSlug: slug, name: `Historical Rehearsal (${division === 'upper' ? 'Upper' : 'Lower'} ${stage === 'main' ? 'Division' : 'Losers'})`,
        eventDate: new Date(stage === 'main' ? '2026-08-25T08:30:00Z' : '2026-08-25T10:45:00Z'),
        challongeState: 'complete', syncState: 'synced', lastSyncedAt: new Date(),
        resultsMode: stage === 'main' ? 'auto' : 'final_stage_only', raw: { tournamentType: 'single elimination' },
      }).returning();
      const ids = stage === 'main' ? actual[division] : actual[division].slice(2);
      const participants = await db.insert(tournamentParticipants).values(ids.map((playerId, index) => ({
        tournamentId: tournament!.id, challongeParticipantId: index + 1, playerId,
        rawName: playerById.get(playerId)!.canonicalName, cleanedName: playerById.get(playerId)!.canonicalName,
        finalRank: index < 2 ? index + 1 : null,
      }))).returning();
      let matchId = 1;
      const addMatch = async (first: number, second: number, resultStage: 'group' | 'final') => {
        await db.insert(sets).values({ tournamentId: tournament!.id, challongeMatchId: matchId++, round: 1,
          state: 'complete', resultStage, p1ParticipantId: participants[first]!.id, p2ParticipantId: participants[second]!.id,
          p1PlayerId: ids[first]!, p2PlayerId: ids[second]!, winner: 1, scoresCsv: '2-0',
        });
      };
      if (stage === 'main') {
        for (let first = 0; first < ids.length; first++) {
          for (let second = first + 1; second < ids.length; second++) await addMatch(first, second, 'group');
        }
        await db.update(eventPlanBrackets).set({ tournamentId: tournament!.id, challongeSlug: slug, externalState: 'attached' })
          .where(eq(eventPlanBrackets.id, plan.brackets.find(bracket => bracket.division === division && bracket.stage === stage)!.id!));
      }
      await addMatch(0, 1, 'final');
    }
  }
  await db.insert(eventOperationSettings).values({ eventPlanId: planId, published: true });
  await closePlan(db, planId, 'complete');
  return planId;
}
