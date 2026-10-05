import {
  eventOperationSettings,
  eventPlanEntries,
  eventPlans,
  players,
  user,
  type Db,
} from '@smashclub/db';
import type { SessionUser } from '../../src/auth';
import { defaultRatingSettings } from '@smashclub/shared';
import { captureBaseline, stableId } from '../../src/tournament/domain';
import {
  initialState,
  type CommandEnvelope,
  type TournamentBaseline,
  type TournamentCommand,
} from '../../src/tournament/schemas';

export const nativeAdmin: SessionUser = {
  id: 'native-admin',
  name: 'TO',
  role: 'admin',
  email: 'native@example.test',
};
export function pureBaseline(): TournamentBaseline {
  const baseline: TournamentBaseline = {
    version: 1,
    announcements: [],
    prizes: [],
    planId: stableId('plan'),
    name: 'Test night',
    eventDate: 1791072000000,
    capturedAt: 1791072000000,
    capturedBy: nativeAdmin.id,
    rankingRecomputeId: null,
    rankingSnapshotAt: null,
    poolSize: 4,
    upperTargetSize: 4,
    ratingContext: {
      settingsVersion: 1,
      settings: defaultRatingSettings,
      rankingModel: null,
      rankingFitSettings: null,
      inputs: [],
    },
    entrants: [],
    pools: [],
    matches: [],
    stations: [],
    settings: {
      ...initialState().settings,
      published: true,
      playerReports: true,
      scoreReportingMode: 'approve_unless_disputed',
      capacity: 1,
    },
  };
  for (const division of ['upper', 'lower'] as const) {
    const ids = Array.from({ length: 4 }, (_, i) => stableId(`${division}:player:${i}`));
    const poolId = stableId(`${division}:pool`);
    baseline.entrants.push(
      ...ids.map((playerId, i) => ({
        id: stableId(`entry:${playerId}`),
        playerId,
        name: `${division} ${i}`,
        division,
        seed: i + 1,
        snapshotRank: i + 1,
        snapshotScore: 1200 - i,
        availability: 'available' as const,
        revision: 0,
      })),
    );
    baseline.pools.push({
      id: poolId,
      division,
      index: 0,
      entrantIds: ids,
      order: null,
      revision: 0,
      active: true,
      stationIds: [],
      selfRun: false,
      autoAcceptScores: false,
      scheduleRevision: 0,
    });
    for (let a = 0; a < ids.length; a++)
      for (let b = a + 1; b < ids.length; b++) {
        const id = stableId(`${division}:${a}:${b}`);
        baseline.matches.push({
          id,
          sourceKey: id,
          division,
          stage: 'group',
          poolId,
          bracketId: null,
          round: 0,
          slot: baseline.matches.length,
          label: id,
          parent1Id: null,
          parent2Id: null,
          player1Id: ids[a]!,
          player2Id: ids[b]!,
          status: 'ready',
          outcome: null,
          score1: null,
          score2: null,
          winnerId: null,
          stationId: null,
          revision: 0,
          started: false,
          completedAt: null,
          automaticFromRevision: null,
          resultCommandId: null,
          liveScore1: null,
          liveScore2: null,
          progressRevision: 0,
          blockedReason: null,
        });
      }
  }
  return baseline;
}
export const pureState = () => captureBaseline(pureBaseline());
export function envelope(
  command: TournamentCommand,
  options: Partial<CommandEnvelope> = {},
): CommandEnvelope {
  const id = crypto.randomUUID();
  return {
    id,
    requestId: id,
    actorId: nativeAdmin.id,
    operator: true,
    at: 1791072100000,
    command,
    ...options,
  };
}
export async function seedNativeDraft(db: Db) {
  await db.insert(user).values(nativeAdmin).onConflictDoNothing();
  const entrants = await db
    .insert(players)
    .values(
      Array.from({ length: 16 }, (_, i) => ({
        canonicalName: `Entrant ${crypto.randomUUID()} ${i}`,
        displayName: `Player ${i}`,
      })),
    )
    .returning();
  const [plan] = await db
    .insert(eventPlans)
    .values({
      name: 'Act night',
      eventDate: new Date('2026-10-03T00:00:00Z'),
      status: 'pools_ready',
      bracketMode: 'native',
      upperTargetSize: 8,
    })
    .returning();
  await db.insert(eventPlanEntries).values(
    entrants.map((p, i) => ({
      eventPlanId: plan!.id,
      playerId: p.id,
      sourceLineNumber: i + 1,
      rawInput: p.canonicalName,
      cleanedName: p.canonicalName,
      assignedDivision: i < 8 ? ('upper' as const) : ('lower' as const),
      divisionSeed: (i % 8) + 1,
      snapshotRank: i + 1,
      snapshotScore: 1300 - i * 10,
    })),
  );
  await db.insert(eventOperationSettings).values({
    eventPlanId: plan!.id,
    published: true,
    playerReports: true,
    scoreReportingMode: 'approve_unless_disputed',
  });
  return plan!.id;
}
