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
