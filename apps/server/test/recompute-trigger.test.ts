import { afterEach, expect, it, vi } from 'vitest';
import type { Db } from '@smashclub/db';
import { backfillRatingRecompute, runRecompute } from '../src/recompute/recompute';
import { RecomputeTrigger } from '../src/recompute/trigger';

vi.mock('../src/recompute/recompute', () => ({
  backfillRatingRecompute: vi.fn(),
  runRecompute: vi.fn(),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

it('checks whether the delayed startup backfill still needs a fit', async () => {
  vi.useFakeTimers();
  vi.mocked(backfillRatingRecompute).mockResolvedValue(null);
  const trigger = new RecomputeTrigger({} as Db, 5);
  trigger.requestBackfill();
  await vi.advanceTimersByTimeAsync(5);
  expect(backfillRatingRecompute).toHaveBeenCalledOnce();
  expect(runRecompute).not.toHaveBeenCalled();
});

it('runs a full recompute for source changes queued before the startup check', async () => {
  vi.useFakeTimers();
  vi.mocked(runRecompute).mockResolvedValue({
    recomputeId: 'run',
    model: 'whr',
    players: 0,
    sets: 0,
    events: 0,
  });
  const trigger = new RecomputeTrigger({} as Db, 5);
  trigger.requestBackfill();
  trigger.request();
  await vi.advanceTimersByTimeAsync(5);
  expect(backfillRatingRecompute).not.toHaveBeenCalled();
  expect(runRecompute).toHaveBeenCalledOnce();
});

it('preserves source changes queued during a running startup backfill', async () => {
  vi.useFakeTimers();
  let complete!: (value: null) => void;
  const pending = new Promise<null>((resolve) => {
    complete = resolve;
  });
  vi.mocked(backfillRatingRecompute).mockReturnValueOnce(pending);
  vi.mocked(runRecompute).mockResolvedValue({
    recomputeId: 'run',
    model: 'whr',
    players: 0,
    sets: 0,
    events: 0,
  });
  const trigger = new RecomputeTrigger({} as Db, 5);
  trigger.requestBackfill();
  await vi.advanceTimersByTimeAsync(5);
  trigger.request();
  await vi.advanceTimersByTimeAsync(5);
  expect(runRecompute).not.toHaveBeenCalled();
  complete(null);
  await vi.advanceTimersByTimeAsync(5);
  expect(backfillRatingRecompute).toHaveBeenCalledOnce();
  expect(runRecompute).toHaveBeenCalledOnce();
});

it('preserves a queued source update when an immediate recompute is already running', async () => {
  vi.useFakeTimers();
  const result = { recomputeId: 'run', model: 'whr' as const, players: 0, sets: 0, events: 0 };
  let complete!: (value: typeof result) => void;
  const pending = new Promise<typeof result>((resolve) => {
    complete = resolve;
  });
  vi.mocked(runRecompute).mockReturnValueOnce(pending).mockResolvedValue(result);
  const trigger = new RecomputeTrigger({} as Db, 5);
  const running = trigger.runNow();
  trigger.request();
  await expect(trigger.runNow()).rejects.toThrow('A rating recompute is already running');
  complete(result);
  await running;
  await vi.advanceTimersByTimeAsync(5);
  expect(runRecompute).toHaveBeenCalledTimes(2);
});
