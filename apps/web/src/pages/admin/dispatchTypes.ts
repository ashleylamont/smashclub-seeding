import type { trpc } from '../../lib/trpc';
export type Overview = Awaited<ReturnType<typeof trpc.eventOps.overview.query>>;
export type Desk = Awaited<ReturnType<typeof trpc.eventOps.live.dispatchDesk.query>>;
export type Command = Parameters<typeof trpc.eventOps.live.command.mutate>[0]['command'];
export type Run = (command: Command) => Promise<boolean>;
