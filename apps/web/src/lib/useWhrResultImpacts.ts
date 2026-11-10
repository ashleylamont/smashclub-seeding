import { useEffect, useRef, useState, type RefObject } from 'react';
import type { PlayerMatchLogEntry } from './apiTypes';
import { trpc } from './trpc';

export type WhrResultImpact =
  Awaited<ReturnType<typeof trpc.public.whrResultImpact.query>> | { status: 'error' };

type RunLoad = {
  recomputeId: string;
  activeSetId: string | null;
  results: ReadonlyMap<string, WhrResultImpact>;
  failure?: 'older_run' | 'stale_run';
};

// The service allows four cold fits per second across clients. A profile sends
// one request at a time, with at least this much time between starts.
const requestInterval = 500;

/** One mounted log per player. Estimates belong to a single run and survive filtering. */
export function useWhrResultImpacts({
  body,
  events,
  playerId,
  recomputeId,
}: {
  body: RefObject<HTMLTableSectionElement | null>;
  events: readonly PlayerMatchLogEntry[];
  playerId: string;
  recomputeId?: string | null;
}) {
  const [visibility, setVisibility] = useState<{
    events: readonly PlayerMatchLogEntry[];
    recomputeId: string;
    setIds: string[];
  }>();
  const [load, setLoad] = useState<RunLoad>();
  const run = load?.recomputeId === recomputeId ? load : undefined;
  const activeSetId = run?.activeSetId;
  const nextStart = useRef(0);

  useEffect(() => {
    if (!recomputeId || !body.current || typeof IntersectionObserver === 'undefined') return;
    const visible = new Set<string>();
    const publish = () =>
      setVisibility({ events, recomputeId, setIds: document.hidden ? [] : [...visible] });
    // Observe the row, so horizontal scrolling never gates a set's estimate.
    // The viewport also clips rows inside the desktop log's own scroller.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const setId = (entry.target as HTMLElement).dataset.whrSetId!;
          if (entry.intersectionRatio >= 0.01) visible.add(setId);
          else visible.delete(setId);
        }
        publish();
      },
      { threshold: 0.01 },
    );
    for (const row of body.current.querySelectorAll('[data-whr-set-id]')) observer.observe(row);
    document.addEventListener('visibilitychange', publish);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', publish);
    };
  }, [body, events, recomputeId]);

  const nextSetId =
    !run?.failure && visibility?.events === events && visibility.recomputeId === recomputeId
      ? visibility.setIds.find((setId) => !run?.results.has(setId))
      : undefined;
  useEffect(() => {
    if (!recomputeId || !nextSetId || activeSetId) return;
    const timer = window.setTimeout(
      () => {
        if (document.hidden) return;
        setLoad((previous) =>
          previous?.recomputeId === recomputeId
            ? { ...previous, activeSetId: nextSetId }
            : { recomputeId, activeSetId: nextSetId, results: new Map() },
        );
      },
      Math.max(0, nextStart.current - performance.now()),
    );
    return () => window.clearTimeout(timer);
  }, [nextSetId, activeSetId, recomputeId]);

  useEffect(() => {
    if (!activeSetId || !recomputeId) return;
    const controller = new AbortController();
    nextStart.current = performance.now() + requestInterval;
    void trpc.public.whrResultImpact
      .query({ playerId, setId: activeSetId, recomputeId }, { signal: controller.signal })
      .catch(() => ({ status: 'error' as const }))
      .then((result) => {
        if (controller.signal.aborted) return;
        setLoad((previous) => {
          if (previous?.recomputeId !== recomputeId || previous.activeSetId !== activeSetId)
            return previous;
          if (
            result.status === 'unavailable' &&
            (result.reason === 'older_run' || result.reason === 'stale_run')
          )
            return { ...previous, activeSetId: null, failure: result.reason };
          return {
            ...previous,
            activeSetId: null,
            results: new Map(previous.results).set(activeSetId, result),
          };
        });
      });
    return () => controller.abort();
  }, [activeSetId, playerId, recomputeId]);

  return { results: run?.results, activeSetId, runFailure: run?.failure };
}
