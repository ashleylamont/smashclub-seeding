import { useEffect, useRef } from 'react';

const EVENT_TYPES = ['set_updated', 'sync_completed', 'recompute_completed'] as const;

/**
 * Subscribe to one of the server's SSE feeds (`/api/live` or
 * `/api/live/:tournamentId`). Pass `null` to disconnect. Reconnection is
 * handled natively by EventSource.
 */
export function useEventSource(url: string | null, onEvent: (type: string, data: unknown) => void): void {
  const handlerRef = useRef(onEvent);
  useEffect(() => {
    handlerRef.current = onEvent;
  });

  useEffect(() => {
    if (!url) return;
    const source = new EventSource(url);
    for (const type of EVENT_TYPES) {
      source.addEventListener(type, (event: MessageEvent) => {
        let data: unknown = null;
        try {
          data = JSON.parse(event.data as string);
        } catch {
          // non-JSON payloads are passed through as null
        }
        handlerRef.current(type, data);
      });
    }
    return () => source.close();
  }, [url]);
}
