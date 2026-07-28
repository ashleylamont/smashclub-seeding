import { initTRPC, TRPCError } from '@trpc/server';
import type { Db } from '@smashclub/db';
import type { ChallongeClient } from '../challonge/client';
import type { SessionUser } from '../auth';
import type { Env } from '../env';
import type { RecomputeTrigger } from '../recompute/trigger';

export interface TrpcContext {
  db: Db;
  env: Env;
  user: SessionUser | null;
  challonge: ChallongeClient;
  recomputeTrigger: RecomputeTrigger;
}

const t = initTRPC.context<TrpcContext>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

export const authedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return next({ ctx: { ...ctx, user: ctx.user } });
});

export const adminProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED' });
  if (ctx.user.role !== 'admin') throw new TRPCError({ code: 'FORBIDDEN' });
  return next({ ctx: { ...ctx, user: ctx.user } });
});
