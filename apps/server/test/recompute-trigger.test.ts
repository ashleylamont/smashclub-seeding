import { afterEach, expect, it, vi } from 'vitest';
import type { Db } from '@smashclub/db';
import { runRecompute } from '../src/recompute/recompute';
import { RecomputeTrigger } from '../src/recompute/trigger';

vi.mock('../src/recompute/recompute', () => ({ runRecompute: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
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
