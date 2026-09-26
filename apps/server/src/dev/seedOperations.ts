import { eq } from 'drizzle-orm';
import { eventAnnouncements, eventOperationSettings, eventOperators, eventPrizes, eventStations, playerClaims, players, user, type Db } from '@smashclub/db';
import { createPlan, freezeRoster, generatePools, getPlan, loadRanking, savePoolPlacements } from '../event-planner/plans';
import { prepare, reportScore, snapshot, updateMatch } from '../event-operations/service';
import type { SessionUser } from '../auth';
import { configureGuests } from '../event-operations/guests';

/** Real services, fake event: an immediately usable local rehearsal, never production startup. */
export async function seedOperations(db: Db): Promise<string> {
  const accounts = await db.select().from(user);
  const admin = accounts.find(account => account.email === 'admin@smashclub.dev');
  const reporter = accounts.find(account => account.email === 'rehearsal-player@smashclub.dev');
  const organiser = accounts.find(account => account.email === 'organiser@smashclub.dev');
  if (!admin || !reporter || !organiser) throw new Error('Rehearsal accounts must be created before seeding operations.');
  const actor: SessionUser = { id: admin.id, email: admin.email, name: admin.name, role: 'admin' };
  const { ranking } = await loadRanking(db);
  const roster = (await db.select().from(players)).filter(player => player.status === 'active' && ranking.has(player.id))
    .sort((a, b) => ranking.get(a.id)!.rank - ranking.get(b.id)!.rank).slice(0, 18);
  if (roster.length !== 18) throw new Error('The rehearsal needs 18 ranked players from the development fixtures.');
  const planId = await createPlan(db, { name: 'Nemesis · Rehearsal Night', eventDate: new Date(), upperTargetSize: 9,
    rows: roster.map((player, index) => ({ lineNumber: index + 1, rawInput: player.canonicalName, cleanedName: player.canonicalName,
      companyId: player.companyId, playerId: player.id, resolutionMethod: 'manual', divisionPreference: 'auto' })) }, admin.id);
  await freezeRoster(db, planId);
  await generatePools(db, planId);
  await prepare(db, planId);
  await db.update(eventOperationSettings).set({ published: true, playerReports: true }).where(eq(eventOperationSettings.eventPlanId, planId));
  await configureGuests(db, actor, { planId, enabled: true, showOnOverlay: true });
  const stations = await db.insert(eventStations).values([{ eventPlanId: planId, name: 'Stage' }, { eventPlanId: planId, name: 'Setup 2' }]).returning();
  await db.insert(eventOperators).values({ eventPlanId: planId, userId: organiser.id });
  const plan = (await getPlan(db, planId))!;
  const completedPool = plan.divisions.find(division => division.division === 'lower')!.pools[0]!;
  const poolOrder = completedPool.members.map(member => member.playerId);
  let view = await snapshot(db, planId);
  for (const match of view.matches.filter(match => match.division === 'lower' && match.poolIndex === completedPool.poolIndex)) {
    const firstWins = poolOrder.indexOf(match.player1Id!) < poolOrder.indexOf(match.player2Id!);
    await reportScore(db, actor, { matchId: match.id, expectedRevision: match.revision, requestId: `demo-${match.id}`,
      score1: firstWins ? 2 : 0, score2: firstWins ? 0 : 2, outcome: 'played' });
  }
  const scoredPool = (await getPlan(db, planId))!.divisions.find(division => division.division === 'lower')!.pools[0]!;
  await savePoolPlacements(db, planId, 'lower', [{ poolIndex: completedPool.poolIndex, playerIdsInOrder: poolOrder, expectedMatchRevisions: scoredPool.matchRevisions, expectedPlacementRevision: scoredPool.placementRevision }]);
  view = await snapshot(db, planId);
  const playing = view.matches.find(match => match.division === 'upper' && match.status === 'ready')!;
  await updateMatch(db, actor, { matchId: playing.id, expectedRevision: playing.revision, status: 'playing', stationId: stations[0]!.id });
  await db.insert(playerClaims).values({ userId: reporter.id, playerId: playing.player1Id!, status: 'approved', resolvedBy: admin.id, resolvedAt: new Date() });
  await db.insert(eventAnnouncements).values({ eventPlanId: planId, message: 'Welcome to Nemesis. Check the live board for your next match and report to your assigned station.' });
  await db.insert(eventPrizes).values([{ eventPlanId: planId, title: 'Upper champion', description: 'Rehearsal trophy · recipient to be confirmed' },
    { eventPlanId: planId, title: 'Good games award', description: 'For bringing the club spirit', playerId: poolOrder[0]! }]);
  return planId;
}
