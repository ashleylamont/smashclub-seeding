import { EventEmitter } from 'node:events';

/**
 * In-process pub/sub for SSE feeds. Single-replica deployment makes this
 * sufficient — no external broker needed.
 */

export interface LiveEvent {
  type: 'set_updated' | 'sync_completed' | 'recompute_completed' | 'tournament_state';
  tournamentId?: string;
  payload?: unknown;
}

class LiveBus extends EventEmitter {
  publish(event: LiveEvent): void {
    this.emit('event', event);
    if (event.tournamentId) {
      this.emit(`tournament:${event.tournamentId}`, event);
    }
  }

  subscribe(listener: (event: LiveEvent) => void, tournamentId?: string): () => void {
    const channel = tournamentId ? `tournament:${tournamentId}` : 'event';
    this.on(channel, listener);
    return () => this.off(channel, listener);
  }
}

export const liveBus = new LiveBus();
