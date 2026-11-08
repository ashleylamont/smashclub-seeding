import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mockEvent, PLAN_ID, ready } from './fixtures';
import type { Desk } from '../src/pages/admin/dispatchTypes';

for (const theme of ['dark', 'light'] as const) {
  for (const width of [390, 1440]) {
    test(`${theme} ${width}px pause recovery focuses the selected untaken call`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const { overview, unexpected } = await mockEvent(page, { role: 'admin', idle: true });
      const calls = overview.matches.filter((match) => match.status === 'ready').slice(0, 2);
      calls[1]!.player1Name =
        'Alexandria with a long doubles alias / Captain Falcon from Western Sydney';
      for (const match of calls)
        Object.assign(match, { status: 'playing', started: false, called: true, stationId: null });
      Object.assign(overview, {
        poolDrawPauseBlocker: {
          kind: 'untaken_calls',
          matchIds: calls.map(({ id }) => id),
          message: 'Matches have been called. Return all untaken calls before pausing the draw.',
        },
        sharedDispatch: { active: 2, capacity: 2, overCapacity: 0 },
        operatorDispatch: {
          mode: 'shared',
          capacity: 2,
          active: 2,
          overCapacity: 0,
          resourceRevision: 1,
          queueRevision: 0,
          stations: [],
          entrants: [],
          pools: [],
          queue: calls.map(({ id }) => ({
            matchId: id,
            state: 'called',
            waitingSince: 0,
            downstream: 0,
            reason: 'Waiting time, then draw order',
            canStart: false,
            canDispatchOrdinary: false,
            eligibleStationIds: [],
            reasons: [],
          })),
        } satisfies Desk,
      });
      await page.goto(`/operate/${PLAN_ID}?view=draw`);
      const panel = page.getByRole('tabpanel', { name: 'Standings / draw' });
      const pause = panel.getByRole('heading', { name: 'Pool draw: Soft-locked' }).locator('../..');
      const selected = calls[1]!;
      const open = pause.getByRole('button', {
        name: `Open call for ${selected.player1Name} vs ${selected.player2Name}`,
      });
      await expect(open).toBeVisible();
      await expect(pause.getByRole('button', { name: /^Open call for/ })).toHaveCount(2);
      await expect(pause.getByRole('button', { name: 'Pause unplayed draw' })).toHaveCount(0);
      await ready(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(
        (
          await new AxeBuilder({ page })
            .include('.ops-page')
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      await pause.screenshot({ path: testInfo.outputPath(`pause-draw-${theme}-${width}.png`) });
      await open.press('Enter');
      const target = page
        .locator(`[data-match-id="${selected.id}"]`)
        .getByRole('button', { name: 'Return untaken call' });
      await expect(target).toBeFocused();
      await expect(page.getByRole('tabpanel', { name: 'Run matches' })).toBeVisible();
      expect(unexpected).toEqual([]);
    });
  }
}
