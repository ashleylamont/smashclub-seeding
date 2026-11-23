import type { Db } from '@smashclub/db';
import { liveBus } from '../live/bus';
import { backfillRatingRecompute, runRecompute } from './recompute';

/**
 * Debounced recompute trigger: bursts of set changes during live polling
 * collapse into one WHR fit ~5s after the last request. Never runs two
 * recomputes concurrently; a request arriving mid-run queues one follow-up.
 */
export class RecomputeTrigger {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private pendingAgain = false;

  constructor(
    private readonly db: Db,
    private readonly debounceMs = 5000,
    private readonly onError: (error: unknown) => void = (error) =>
      console.error('recompute failed', error),
  ) {}

  request(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.fire('source'), this.debounceMs);
  }

  requestBackfill(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => void this.fire('backfill'), this.debounceMs);
  }

  /** Run immediately (admin "recompute now", tests). */
  async runNow(): Promise<void> {
    if (this.running) throw new Error('A rating recompute is already running');
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.fire('manual');
  }

  private async fire(mode: 'source' | 'backfill' | 'manual'): Promise<void> {
    this.timer = null;
    if (this.running) {
      if (mode !== 'backfill') this.pendingAgain = true;
      return;
    }
    this.running = true;
    try {
      const result =
        mode === 'backfill' ? await backfillRatingRecompute(this.db) : await runRecompute(this.db);
      if (result) liveBus.publish({ type: 'recompute_completed', payload: result });
    } catch (error) {
      this.onError(error);
      if (mode === 'manual') throw error;
    } finally {
      this.running = false;
      if (this.pendingAgain) {
        this.pendingAgain = false;
        this.request();
      }
    }
  }
}
