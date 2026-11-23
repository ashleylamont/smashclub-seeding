import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { Desk } from '../src/pages/admin/dispatchTypes';
import { mockEvent, PLAN_ID, ready } from './fixtures';

async function calledQueue(page: Page, role: 'admin' | 'player' = 'admin', hasReport = false) {
  const { overview, mutationResponses, unexpected } = await mockEvent(page, { role, idle: true });
  const report = overview.reports[0]!;
  const call = overview.matches.find((match) => match.status === 'ready')!;
  Object.assign(call, {
    status: 'playing',
    started: false,
    called: true,
    stationId: null,
    resourceRevision: 12,
    player1Name: 'Alexandria with a long tournament alias from Western Sydney',
  });
  const desk: Desk = {
    mode: 'shared',
    capacity: 2,
    active: 1,
    overCapacity: 0,
    resourceRevision: 12,
    queueRevision: 0,
    stations: [],
    entrants: [],
    pools: [],
    queue: [
      {
        matchId: call.id,
        state: 'called',
        waitingSince: 0,
        downstream: 0,
        reason: 'Waiting time, then draw order',
        canStart: false,
        canDispatchOrdinary: false,
        eligibleStationIds: [],
        reasons: [],
      },
    ],
  };
  const sharedDispatch = { active: 1, capacity: 2, overCapacity: 0 };
  Object.assign(overview.plan, { liveOwned: true, bracketMode: 'native', drawPaused: false });
  Object.assign(overview, {
    matches: [call],
    reports: hasReport
      ? [{ ...report, matchId: call.id, expectedRevision: call.revision, status: 'pending' }]
      : [],
    withdrawals: [],
    brackets: [],
    nativeBrackets: [],
    operatorDispatch: desk,
    sharedDispatch,
  });
  const returns: unknown[] = [];
  mutationResponses.set('eventOps.live.command', (input) => {
    returns.push(input);
    Object.assign(call, { status: 'ready', called: false, resourceRevision: 13 });
    desk.active = 0;
    desk.resourceRevision = 13;
    desk.queue = [];
    sharedDispatch.active = 0;
    return {};
  });
  return { call, returns, unexpected };
}

for (const theme of ['dark', 'light'] as const) {
  for (const width of [390, 1440]) {
    test(`${theme} ${width}px queue reset reaches the guarded return and restores the Settings panel`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const { call, returns, unexpected } = await calledQueue(page);
      await page.goto(`/operate/${PLAN_ID}?view=settings`);
      const settings = page.getByRole('tabpanel', { name: 'Settings' });
      const disclosure = settings.getByRole('button', { name: 'Before play: reset match queue' });
      const reset = settings.getByRole('button', { name: 'Reset unplayed queue' });
      await disclosure.press('Enter');
      await expect(reset).toBeDisabled();
      await expect(
        settings.getByText('Return the untaken call before resetting the queue.'),
      ).toBeVisible();
      const openCall = settings.getByRole('button', {
        name: `Open call for ${call.player1Name} vs ${call.player2Name}`,
      });
      await expect(openCall).toBeVisible();
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
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await page.screenshot({
        path: testInfo.outputPath('queue-reset-blocked.png'),
        fullPage: true,
      });

      await openCall.press('Enter');
      const run = page.getByRole('tabpanel', { name: 'Run matches' });
      const returnCall = run
        .locator(`[data-match-id="${call.id}"]`)
        .getByRole('button', { name: 'Return untaken call' });
      await expect(returnCall).toBeFocused();
      await returnCall.press('Enter');
      await expect(returnCall).toHaveCount(0);

      const settingsTab = page.getByRole('tab', { name: 'Settings' });
      await page.getByRole('tab', { name: 'Run matches' }).press('End');
      await expect(settingsTab).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(reset).toBeEnabled();
      await expect(openCall).toHaveCount(0);
      expect(returns).toEqual([
        expect.objectContaining({
          command: expect.objectContaining({
            kind: 'matchControl',
            matchId: call.id,
            status: 'ready',
            onlyIfUntaken: true,
            expectedRevision: call.revision,
            expectedResourceRevision: 12,
          }),
        }),
      ]);
      expect(unexpected).toEqual([]);
      await reset.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath('queue-reset-ready.png') });
    });
  }
}

test('a pending score report suppresses call recovery for queue reset', async ({ page }) => {
  const { returns, unexpected } = await calledQueue(page, 'admin', true);
  await page.goto(`/operate/${PLAN_ID}?view=settings`);
  const settings = page.getByRole('tabpanel', { name: 'Settings' });
  await settings.getByRole('button', { name: 'Before play: reset match queue' }).press('Enter');
  await expect(settings.getByRole('button', { name: 'Reset unplayed queue' })).toBeDisabled();
  await expect(
    settings.getByText('Score reports have been recorded. The queue cannot be reset.'),
  ).toBeVisible();
  await expect(settings.getByRole('button', { name: /Open call for/ })).toHaveCount(0);
  expect(returns).toEqual([]);
  expect(unexpected).toEqual([]);
});

test('an assigned organiser keeps the existing Settings permissions', async ({ page }) => {
  const { returns, unexpected } = await calledQueue(page, 'player');
  await page.goto(`/operate/${PLAN_ID}?view=settings`);
  const settings = page.getByRole('tabpanel', { name: 'Settings' });
  await expect(settings).toBeVisible();
  await expect(
    settings.getByRole('button', { name: 'Before play: reset match queue' }),
  ).toHaveCount(0);
  expect(returns).toEqual([]);
  expect(unexpected).toEqual([]);
});
