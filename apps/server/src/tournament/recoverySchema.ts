import { z } from 'zod';

export const RecoveryInput = z.object({
  operation: z.enum(['reset', 'delete']),
  replacementPlanId: z.uuid().nullable(),
  withdrawResults: z.boolean(),
  reason: z.string().trim().min(1).max(200),
});
export const Retirement = RecoveryInput.extend({
  requestId: z.string().min(1).max(128),
  actorId: z.string(),
  at: z.number(),
});

export const LegacyPoolOrderRepairReview = z.object({
  poolId: z.uuid(),
  expectedSequence: z.number().int().positive(),
  expectedPoolRevision: z.number().int().nonnegative(),
  revisionToken: z.string().length(64),
  reason: z.string().trim().min(1).max(200),
});

const JournalReference = z.object({ id: z.number().int().nonnegative(), at: z.number() });
export const LegacyPoolOrderRepairEvidence = z.object({
  order: z.array(z.uuid()).min(1).max(500),
  confirmation: JournalReference.extend({ source: z.enum(['imported', 'confirmed']) }),
  withdrawal: JournalReference.extend({ playerId: z.uuid() }),
});
