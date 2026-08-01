import { useEffect, useState } from 'react';

/** How often the clock ticks. Fine for windows measured in hours. */
const DEFAULT_INTERVAL_MS = 30_000;

/**
 * The current time, as state that ticks.
 *
 * Reading `Date.now()` during render is impure — React may re-render at any
 * moment, so the value jumps unpredictably — and here it was also a real bug:
 * both callers decide whether a *live window has expired*, and a window that
 * ran out while the page sat open kept rendering as live until something
 * unrelated happened to re-render it. Reading the clock on an interval instead
 * makes the expiry actually arrive.
 *
 * Call this once per screen and pass the value down; one timer for a table
 * beats one per row.
 */
export function useNow(intervalMs: number = DEFAULT_INTERVAL_MS): number {
  const [now, setNow] = useState(() => Date.now());

  // A subscription to an external system — the clock — which is the shape an
  // effect is for. The initial value comes from the lazy initialiser above, so
  // the effect never has to set state synchronously to catch up.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return now;
}
