import { structureOptionsSchema, tournamentStructureSchema } from '@smashclub/shared';
import { z } from 'zod';
import { Retirement } from './recoverySchema';
import { additionalCommands } from './commands';

const id = z.uuid();
const revision = z.number().int().nonnegative();
const Announcement = z.object({
  id,
  message: z.string(),
  createdAt: z.number(),
  expiresAt: z.number().nullable(),
});
const Prize = z.object({
  id,
  title: z.string(),
  description: z.string().nullable(),
  playerId: id.nullable(),
});
export const Division = z.enum(['upper', 'lower']);
export const QualifierSource = z.object({
  poolId: id,
  poolIndex: revision,
  division: Division,
  place: revision.min(1),
  status: z.enum(['pending', 'resolved', 'review_pending']),
});
export const QualifierSlot = QualifierSource.extend({
  entrantId: id.nullable(),
  eligibleEntrantIds: z.array(id),
});
export const LiveMatch = z.object({
  id,
  sourceKey: z.string(),
  division: Division,
  stage: z.enum(['group', 'main', 'consolation']),
  poolId: id.nullable(),
  bracketId: id.nullable(),
  round: revision,
  slot: revision,
  label: z.string(),
  parent1Id: id.nullable(),
  parent2Id: id.nullable(),
  parent1Outcome: z.enum(['winner', 'loser']).optional(),
  parent2Outcome: z.enum(['winner', 'loser']).optional(),
  activation: z
    .object({ matchId: id, winnerSide: z.union([z.literal(1), z.literal(2)]) })
    .optional(),
  skipped: z.boolean().optional(),
  bracketLane: z.enum(['winners', 'losers', 'final', 'reset']).optional(),
  bracketRound: revision.optional(),
  player1Id: id.nullable(),
  player2Id: id.nullable(),
  player1Qualifier: QualifierSource.optional(),
  player2Qualifier: QualifierSource.optional(),
  qualificationBlocks: z.array(QualifierSource).optional(),
  status: z.enum(['ready', 'playing', 'complete', 'blocked']),
  outcome: z.enum(['played', 'bye', 'forfeit', 'no_contest']).nullable(),
  score1: revision.nullable(),
  score2: revision.nullable(),
  winnerId: id.nullable(),
  stationId: id.nullable(),
  revision,
  started: z.boolean(),
  completedAt: z.number().nullable(),
  automaticFromRevision: revision.nullable(),
  resultCommandId: id.nullable(),
  liveScore1: revision.nullable().default(null),
  liveScore2: revision.nullable().default(null),
  progressRevision: revision.default(0),
  calledAt: z.number().nullable().optional(),
  callLocation: z.string().max(100).nullable().optional(),
  readySince: z.number().optional(),
  held: z.boolean().optional(),
  blockedReason: z.string().nullable().default(null),
});
export const Entrant = z.object({
  id,
  /** V1 transport name: an entrant key, equal to entry ID for doubles. */
  playerId: id,
  memberPlayerIds: z.array(id).min(1).max(2).optional(),
  memberAvailability: z.record(id, z.enum(['available', 'snoozed'])).optional(),
  teamName: z.string().nullable().optional(),
  snapshotMean: z.number().nullable().optional(),
  snapshotSd: z.number().nonnegative().nullable().optional(),
  name: z.string(),
  division: Division,
  seed: revision,
  snapshotRank: revision.nullable(),
  snapshotScore: z.number().nullable(),
  availability: z.enum(['available', 'snoozed', 'withdrawn']),
  revision,
});
export const Pool = z.object({
  id,
  division: Division,
  index: revision,
  entrantIds: z.array(id),
  order: z.array(id).nullable(),
  qualifierRoster: z.array(id).optional(),
  revision,
  // Absent on old facts; these events retain explicit TO placement decisions.
  orderDecision: z
    .object({
      source: z.enum(['automatic', 'manual']),
      policy: z.literal('unique_set_wins_v1'),
      order: z.array(id),
      resultBasis: z.string().length(64),
      matchRevisions: z.record(id, revision),
      commandId: id,
      decidedAt: z.number(),
    })
    .optional(),
  active: z.boolean(),
  stationIds: z.array(id),
  selfRun: z.boolean(),
  autoAcceptScores: z.boolean(),
  scheduleRevision: revision.default(0),
});
export const Station = z.object({ id, name: z.string(), enabled: z.boolean(), revision });
export const Bracket = z.object({
  id,
  division: Division,
  stage: z.enum(['main', 'consolation']),
  entrantIds: z.array(id),
  qualifierSlots: z.array(QualifierSlot).optional(),
});
export const LiveSettings = z.object({
  published: z.boolean(),
  playerReports: z.boolean(),
  scoreReportingMode: z.enum(['to_review', 'approve_unless_disputed']),
  capacity: revision,
  // Absent on old journal facts: their station-bank semantics remain unchanged.
  dispatchMode: z.literal('shared').optional(),
  poolOrderPolicy: z.literal('unique_set_wins_v1').optional(),
  finalsProgression: z.literal('rolling_pool_places_v1').optional(),
  reservedStationIds: z.array(id).optional(),
  queueOrder: z.array(id).optional(),
  queueRevision: revision.optional(),
  resourceRevision: revision,
  reportingRevision: revision,
});
export const Baseline = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  competitionFormat: z.enum(['singles', 'doubles']).optional(),
  structure: tournamentStructureSchema.optional(),
  structureOptions: structureOptionsSchema.optional(),
  planId: id,
  name: z.string(),
  eventDate: z.number(),
  capturedAt: z.number(),
  capturedBy: z.string(),
  rankingRecomputeId: id.nullable(),
  rankingSnapshotAt: z.number().nullable(),
  ratingContext: z.object({
    doubles: z.record(z.string(), z.json()).optional(),
    settingsVersion: revision,
    settings: z.record(z.string(), z.json()),
    rankingModel: z.string().nullable(),
    rankingFitSettings: z.record(z.string(), z.json()).nullable(),
    inputs: z.array(
      z.object({
        playerId: id,
        rank: revision,
        skillRating: z.number(),
        skillSd: z.number(),
        conservativeRating: z.number(),
        rating: z.number(),
        rd: z.number(),
        vol: z.number(),
      }),
    ),
  }),
  poolSize: revision,
  upperTargetSize: revision.nullable(),
  entrants: z.array(Entrant),
  pools: z.array(Pool),
  matches: z.array(LiveMatch),
  brackets: z.array(Bracket).optional(),
  stations: z.array(Station),
  settings: LiveSettings,
  announcements: z.array(Announcement).default([]),
  prizes: z.array(Prize).default([]),
});
export const Report = z.object({
  id,
  matchId: id,
  actorId: z.string(),
  requestId: z.string(),
  submittedRevision: revision,
  expectedRevision: revision,
  score1: revision.nullable(),
  score2: revision.nullable(),
  winnerId: id,
  outcome: z.enum(['played', 'forfeit', 'bye']),
  status: z.enum(['pending', 'approved', 'rejected']),
  autoApproved: z.boolean(),
  isDispute: z.boolean(),
  createdAt: z.number(),
});
export const Result = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  competitionFormat: z.enum(['singles', 'doubles']).optional(),
  structure: tournamentStructureSchema.optional(),
  structureOptions: structureOptionsSchema.optional(),
  poolOrders: z.array(z.object({ division: Division, order: z.array(id) })).optional(),
  id,
  planId: id,
  revision,
  name: z.string(),
  eventDate: z.number(),
  sealedAt: z.number(),
  replacesResultId: id.nullable().default(null),
  replacementReason: z.string().nullable().default(null),
  entrants: z.array(Entrant),
  brackets: z.array(Bracket),
  matches: z.array(LiveMatch),
});
export const Receipt = z.object({
  hash: z.string(),
  sequence: revision,
  reportId: id.nullable(),
  commandId: id.optional(),
});
export const LiveState = z.object({
  // Absent on old facts; display preferences never participate in competitive state.
  broadcastSides: z
    .record(
      id,
      z.object({
        matchId: id,
        player1Id: id,
        player2Id: id,
        matchRevision: revision,
        swapped: z.boolean(),
        revision,
      }),
    )
    .optional(),
  retirement: Retirement.optional(),
  baseline: Baseline.nullable(),
  lifecycle: z.enum(['absent', 'locked', 'unlocked', 'finalized', 'cancelled']),
  sequence: revision,
  entrants: z.array(Entrant),
  pools: z.array(Pool),
  matches: z.array(LiveMatch),
  stations: z.array(Station),
  brackets: z.array(Bracket),
  settings: LiveSettings,
  reports: z.array(Report),
  receipts: z.record(z.string(), Receipt),
  result: Result.nullable(),
  publication: z.object({ resultId: id, tournamentIds: z.array(id) }).nullable(),
  announcements: z
    .array(
      z.object({
        id,
        message: z.string(),
        createdAt: z.number(),
        expiresAt: z.number().nullable(),
      }),
    )
    .default([]),
  prizes: z
    .array(
      z.object({
        id,
        title: z.string(),
        description: z.string().nullable(),
        playerId: id.nullable(),
      }),
    )
    .default([]),
});
export const Command = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('score'),
    matchId: id,
    expectedRevision: revision,
    score1: revision.max(5).nullable(),
    score2: revision.max(5).nullable(),
    winnerId: id.optional(),
    outcome: z.enum(['played', 'forfeit']),
  }),
  z.object({
    kind: z.literal('review'),
    reportId: id,
    approve: z.boolean(),
    expectedRevision: revision,
  }),
  z.object({
    kind: z.literal('dispatch'),
    matchId: id,
    stationId: id.nullable(),
    callLocation: z.string().trim().max(100).nullable().optional(),
    callOnly: z.boolean().optional(),
    expectedRevision: revision,
    expectedResourceRevision: revision,
  }),
  z.object({
    kind: z.literal('availability'),
    playerId: id,
    availability: z.enum(['available', 'snoozed', 'withdrawn']),
    expectedRevision: revision,
    reason: z.string().trim().min(1).max(200),
  }),
  z.object({
    kind: z.literal('resources'),
    capacity: revision.max(128),
    stations: z.array(Station).max(128),
    expectedResourceRevision: revision,
  }),
  z.object({
    kind: z.literal('reporting'),
    published: z.boolean(),
    playerReports: z.boolean(),
    mode: z.enum(['to_review', 'approve_unless_disputed']),
    expectedRevision: revision,
  }),
  z.object({
    kind: z.literal('poolResources'),
    poolId: id,
    active: z.boolean(),
    stationIds: z.array(id),
    selfRun: z.boolean(),
    autoAcceptScores: z.boolean(),
    expectedResourceRevision: revision,
  }),
  z.object({
    kind: z.literal('placements'),
    poolId: id,
    order: z.array(id),
    expectedRevision: revision,
    matchRevisions: z.record(id, revision),
  }),
  z.object({
    kind: z.literal('drawFinals'),
    revisionToken: z.string().length(64).optional(),
    replaceExisting: z.boolean().optional(),
  }),
  z.object({ kind: z.literal('unlock') }),
  z.object({ kind: z.literal('relock') }),
  z.object({ kind: z.literal('finalize') }),
  ...additionalCommands,
]);
export const Envelope = z.object({
  id,
  requestId: z.string().min(1).max(128),
  actorId: z.string(),
  operator: z.boolean(),
  guest: z.boolean().optional(),
  at: z.number(),
  command: Command,
  inputHash: z.string().optional(),
});
/** Persist decided state changes; reducers do not rerun scheduling/draw policy. */
export const Decision = z.object({
  version: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  commandId: id,
  actorId: z.string(),
  requestId: z.string(),
  kind: z.string(),
  at: z.number(),
  basis: z.record(z.string(), revision),
  command: Command,
  source: z.enum(['operator', 'attendee', 'guest']),
  correctionOf: id.nullable(),
  causation: z.array(id),
  // Arrays replace rather than merge; all chosen IDs/results are persisted.
  after: LiveState.omit({
    baseline: true,
    receipts: true,
    sequence: true,
    announcements: true,
    prizes: true,
  })
    .extend({ announcements: z.array(Announcement), prizes: z.array(Prize) })
    .partial(),
  receiptKey: z.string(),
  receipt: Receipt,
});
export type QualifierSource = z.infer<typeof QualifierSource>;
export type QualifierSlot = z.infer<typeof QualifierSlot>;
export type Match = z.infer<typeof LiveMatch>;
export type TournamentState = z.infer<typeof LiveState>;
export type TournamentBaseline = z.infer<typeof Baseline>;
export type TournamentResult = z.infer<typeof Result>;
export type TournamentCommand = z.infer<typeof Command>;
export type CommandEnvelope = z.infer<typeof Envelope>;
export type TournamentDecision = z.infer<typeof Decision>;

export function initialState(): TournamentState {
  return {
    baseline: null,
    lifecycle: 'absent',
    sequence: 0,
    entrants: [],
    pools: [],
    matches: [],
    stations: [],
    brackets: [],
    reports: [],
    receipts: {},
    result: null,
    publication: null,
    announcements: [],
    prizes: [],
    settings: {
      published: false,
      playerReports: false,
      scoreReportingMode: 'to_review',
      capacity: 0,
      resourceRevision: 0,
      reportingRevision: 0,
    },
  };
}
