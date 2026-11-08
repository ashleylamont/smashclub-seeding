import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { trpc } from '../../lib/trpc';
import type { Command, Run } from './dispatchTypes';

export function useDispatchCommand(planId: string, disabled: boolean) {
  const cache = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const retry = useRef<{ input: string; id: string } | null>(null);
  const busy = disabled || pending;
  const run: Run = async (command) => {
    if (busy || inFlight.current) return false;
    inFlight.current = true;
    setPending(true);
    setError('');
    const input = JSON.stringify({ planId, command });
    if (retry.current?.input !== input) retry.current = { input, id: crypto.randomUUID() };
    try {
      await trpc.eventOps.live.command.mutate({ planId, requestId: retry.current.id, command });
      retry.current = null;
      await cache.invalidateQueries({ queryKey: ['eventOps', planId] });
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not change the match queue.');
      return false;
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  return { busy, error, run };
}

export type DispatchCommandController = ReturnType<typeof useDispatchCommand>;

export function namedStationStart(
  matchId: string,
  stationId: string,
  expectedRevision: number,
  expectedResourceRevision: number,
): Extract<Command, { kind: 'dispatch' }> {
  return {
    kind: 'dispatch',
    matchId,
    stationId,
    expectedRevision,
    expectedResourceRevision,
    callOnly: false,
  };
}
