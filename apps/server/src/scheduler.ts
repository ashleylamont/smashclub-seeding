import { and, gt, inArray, isNull, lte, or } from 'drizzle-orm';
import { Cron } from 'croner';
import type { Db } from '@smashclub/db';
import { tournaments } from '@smashclub/db';
import type { ChallongeClient } from './challonge/client';
import type { RecomputeTrigger } from './recompute/trigger';
import { syncTournament } from './sync/sync';

/**
 * 60s, not the original 15s. Live polls now go to the unmetered public bracket
 * rather than the API, but they are still requests to someone else's service,
 * and a club leaderboard gains nothing from refreshing four times a minute.
 */
const LIVE_POLL_MS = 60_000;

/**
 * In-process sync scheduler (single replica; a pg advisory lock in index.ts
 * guards accidental double-runs):
 * - live tournaments: an ADMIN opens a bounded window (`tournaments.liveUntil`)
 *   and they are polled every ~60s through the unmetered public bracket, until
 *   the window expires or the bracket completes
 * - pending/upcoming: every 10 min on event day, hourly within 7 days,
 *   daily otherwise (cron sweep decides who is due)
 * - completed-but-unsynced: picked up by the sweep
 *
 * LIVENESS IS NEVER INFERRED FROM CHALLONGE STATE. `underway` is sticky —
 * tournaments abandoned years ago still report it, and an unfinished public
 * bracket cannot be told apart from one in progress — so inferring it meant
 * polling dead tournaments forever. Challonge's free tier is 500 API requests
 * per MONTH; a single permanently-"live" tournament exhausted that in about 40
 * minutes.
 */
export class SyncScheduler {
  private liveTimer: ReturnType<typeof setInterval> | null = null;
  private sweepJob: Cron | null = null;
  private syncing = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly client: ChallongeClient,
    private readonly recomputeTrigger: RecomputeTrigger,
    private readonly log: (message: string) => void = console.log,
  ) {}

  start(): void {
    this.liveTimer = setInterval(() => void this.pollLive(), LIVE_POLL_MS);
    // Sweep every 10 minutes; per-tournament cadence is applied inside.
    this.sweepJob = new Cron('*/10 * * * *', () => void this.sweep());
    void this.sweep();
  }

  stop(): void {
    if (this.liveTimer) clearInterval(this.liveTimer);
    this.sweepJob?.stop();
  }

  private async pollLive(): Promise<void> {
    // Only tournaments an admin has explicitly opened a window for, and only
    // while that window is open. An expired window simply stops matching — no
    // cleanup pass is required for polling to stop.
    const liveRows = await this.db
      .select({ id: tournaments.id })
      .from(tournaments)
      .where(gt(tournaments.liveUntil, new Date()));
    for (const row of liveRows) {
      // `public`: live polling must never touch the metered API.
      await this.syncOne(row.id, true, { source: 'public' });
    }
  }

  private async sweep(): Promise<void> {
    const rows = await this.db
      .select()
      .from(tournaments)
      .where(
        and(
          inArray(tournaments.syncState, ['registered', 'live', 'error']),
          // Skip anything the fast poller currently owns; an expired or absent
          // window falls back to the sweep automatically.
          or(isNull(tournaments.liveUntil), lte(tournaments.liveUntil, new Date())),
        ),
      );
    const now = Date.now();
    for (const row of rows) {
      const last = row.lastSyncedAt?.getTime() ?? 0;
      const eventTime = row.eventDate?.getTime();
      let interval = 24 * 60 * 60 * 1000;
      if (eventTime !== undefined) {
        const distance = Math.abs(eventTime - now);
        if (distance < 24 * 60 * 60 * 1000) interval = 10 * 60 * 1000;
        else if (distance < 7 * 24 * 60 * 60 * 1000) interval = 60 * 60 * 1000;
      } else {
        // Never synced (no event date yet): sync promptly.
        interval = 0;
      }
      if (now - last >= interval) {
        await this.syncOne(row.id, false);
      }
    }
  }

  private async syncOne(
    tournamentId: string,
    isLivePoll: boolean,
    options: { source?: 'api' | 'public' } = {},
  ): Promise<void> {
    if (this.syncing.has(tournamentId)) return;
    this.syncing.add(tournamentId);
    try {
      const result = await syncTournament(this.db, this.client, tournamentId, options);
      if (result.setsChanged > 0) {
        this.recomputeTrigger.request();
      }
      if (!isLivePoll && result.setsChanged > 0) {
        this.log(`synced ${tournamentId}: ${result.setsChanged} sets changed`);
      }
    } catch (error) {
      this.log(`sync failed for ${tournamentId}: ${String(error)}`);
    } finally {
      this.syncing.delete(tournamentId);
    }
  }
}

/** Serialise scheduler startup across replicas via a pg advisory lock. */
export async function acquireSchedulerLock(db: Db): Promise<boolean> {
  const result = await db.execute<{ locked: boolean }>(
    // Fixed app-specific lock key.
    `select pg_try_advisory_lock(824361002) as locked`,
  );
  const rows = (result as unknown as { rows?: Array<{ locked: boolean }> }).rows ?? [];
  return rows[0]?.locked === true;
}
