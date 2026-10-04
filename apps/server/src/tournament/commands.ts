import { z } from 'zod';
const id = z.uuid();
const revision = z.number().int().nonnegative();
const poolOrder = z.object({
  poolId: id,
  order: z.array(id),
  expectedRevision: revision,
  matchRevisions: z.record(id, revision),
});
export const additionalCommands = [
  z.object({
    kind: z.literal('progress'),
    matchId: id,
    expectedRevision: revision,
    expectedProgressRevision: revision,
    score1: revision.max(5),
    score2: revision.max(5),
  }),
  z.object({
    kind: z.literal('matchControl'),
    matchId: id,
    expectedRevision: revision,
    expectedResourceRevision: revision,
    status: z.enum(['ready', 'blocked']),
    stationId: id.nullable(),
    reason: z.string().max(200).nullable(),
  }),
  z.object({ kind: z.literal('poolOrders'), pools: z.array(poolOrder).min(1).max(128) }),
  z.object({
    kind: z.literal('configurePools'),
    pools: z
      .array(
        z.object({
          poolId: id,
          expectedRevision: revision,
          active: z.boolean(),
          stationIds: z.array(id),
          selfRun: z.boolean(),
          autoAcceptScores: z.boolean(),
        }),
      )
      .min(1)
      .max(128),
  }),
  z.object({
    kind: z.literal('station'),
    id,
    name: z.string().trim().min(1).max(60).nullable(),
    expectedResourceRevision: revision,
  }),
  z.object({
    kind: z.literal('announce'),
    message: z.string().trim().min(1).max(500),
    durationSeconds: revision.min(1).max(86400).nullable(),
  }),
  z.object({
    kind: z.literal('prize'),
    id,
    title: z.string().trim().min(1).max(100),
    description: z.string().max(500).nullable(),
    playerId: id.nullable(),
  }),
  z.object({ kind: z.literal('resetFinals'), revisionToken: z.string().length(64) }),
  z.object({ kind: z.literal('resetQueue') }),
  z.object({ kind: z.literal('cancel'), reason: z.string().trim().min(1).max(200) }),
  z.object({
    kind: z.literal('attendance'),
    action: z.enum(['add', 'no_show', 'redistribute', 'withdraw']),
    playerId: id,
    division: z.enum(['upper', 'lower']).optional(),
    poolIndex: revision.optional(),
    reason: z.string().max(200),
    approveRedistribution: z.boolean(),
    revisionToken: z.string().length(64),
    entrant: z
      .object({
        id,
        name: z.string(),
        snapshotRank: revision.nullable(),
        snapshotScore: z.number().nullable(),
      })
      .optional(),
  }),
  z.object({
    kind: z.literal('replaceResult'),
    resultId: id,
    reason: z.string().trim().min(1).max(500),
    corrections: z
      .array(
        z.object({
          matchId: id,
          expectedRevision: revision,
          score1: revision.max(5).nullable(),
          score2: revision.max(5).nullable(),
          winnerId: id.optional(),
          outcome: z.enum(['played', 'forfeit']),
        }),
      )
      .min(1)
      .max(128),
  }),
] as const;
