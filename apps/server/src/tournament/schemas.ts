import { z } from 'zod';

const id = z.uuid();
const revision = z.number().int().nonnegative();
export const Division = z.enum(['upper', 'lower']);
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
  player1Id: id.nullable(),
  player2Id: id.nullable(),
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
});
export const Entrant = z.object({
  id,
  playerId: id,
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
  revision,
  active: z.boolean(),
  stationIds: z.array(id),
  selfRun: z.boolean(),
  autoAcceptScores: z.boolean(),
});
export const Station = z.object({ id, name: z.string(), enabled: z.boolean(), revision });
export const Bracket = z.object({
  id,
  division: Division,
  stage: z.enum(['main', 'consolation']),
  entrantIds: z.array(id),
});
export const LiveSettings = z.object({
  published: z.boolean(),
  playerReports: z.boolean(),
  scoreReportingMode: z.enum(['to_review', 'approve_unless_disputed']),
  capacity: revision,
  resourceRevision: revision,
  reportingRevision: revision,
});
export const Baseline = z.object({
  version: z.literal(1),
  planId: id,
  name: z.string(),
  eventDate: z.number(),
  capturedAt: z.number(),
  capturedBy: z.string(),
  rankingRecomputeId: id.nullable(),
  rankingSnapshotAt: z.number().nullable(),
  ratingContext: z.object({
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
  stations: z.array(Station),
  settings: LiveSettings,
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
  outcome: z.enum(['played', 'forfeit']),
  status: z.enum(['pending', 'approved', 'rejected']),
  autoApproved: z.boolean(),
  isDispute: z.boolean(),
  createdAt: z.number(),
});
export const Result = z.object({
  version: z.literal(1),
  id,
  planId: id,
  revision,
  name: z.string(),
  eventDate: z.number(),
  sealedAt: z.number(),
  entrants: z.array(Entrant),
  brackets: z.array(Bracket),
  matches: z.array(LiveMatch),
});
export const Receipt = z.object({ hash: z.string(), sequence: revision, reportId: id.nullable() });
export const LiveState = z.object({
  baseline: Baseline.nullable(),
  lifecycle: z.enum(['absent', 'locked', 'unlocked', 'finalized']),
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
  z.object({ kind: z.literal('drawFinals') }),
  z.object({ kind: z.literal('unlock') }),
  z.object({ kind: z.literal('relock') }),
  z.object({ kind: z.literal('finalize') }),
]);
export const Envelope = z.object({
  id,
  requestId: z.string().min(1).max(128),
  actorId: z.string(),
  operator: z.boolean(),
  at: z.number(),
  command: Command,
});
/** Persist decided state changes; reducers do not rerun scheduling/draw policy. */
export const Decision = z.object({
  version: z.literal(1),
  commandId: id,
  actorId: z.string(),
  requestId: z.string(),
  kind: z.string(),
  at: z.number(),
  basis: z.record(z.string(), revision),
  command: Command,
  source: z.enum(['operator', 'attendee']),
  correctionOf: id.nullable(),
  causation: z.array(id),
  // Arrays replace rather than merge; all chosen IDs/results are persisted.
  after: LiveState.omit({ baseline: true, receipts: true, sequence: true }).partial(),
  receiptKey: z.string(),
  receipt: Receipt,
});
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
