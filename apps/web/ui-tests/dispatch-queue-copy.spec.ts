import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { Desk } from '../src/pages/admin/dispatchTypes';
import { chooseOption, clearInput } from '../test-support/controls';
import { mockEvent, PLAN_ID, ready } from './fixtures';

const longAlias = 'Alexandria with a long tournament alias from Western Sydney';
const searchMiss = 'No pairings match this search. Clear the search to see this view.';

async function fixture(page: Page) {
  const { overview, responses, unexpected } = await mockEvent(page, { role: 'admin' });
  const [readyMatch, waitingMatch, heldMatch] = overview.matches.filter(
    ({ status }) => status === 'ready',
  );
  Object.assign(readyMatch!, { player1Name: longAlias });
  Object.assign(heldMatch!, { status: 'blocked' });
  Object.assign(overview.plan, { bracketMode: 'native', drawPaused: false, liveOwned: true });
  overview.reports = [];
  const desk: Desk = {
    mode: 'shared',
    capacity: 2,
    active: 0,
    overCapacity: 0,
    resourceRevision: 12,
    queueRevision: 0,
    stations: [],
    entrants: [],
    pools: [],
    queue: [readyMatch!, waitingMatch!, heldMatch!].map((match, index) => ({
      matchId: match.id,
      state: index === 0 ? 'ready' : 'blocked',
      waitingSince: 0,
      downstream: 0,
      reason: index === 0 ? 'TO order' : 'Waiting time, then draw order',
      canStart: index === 0,
      canDispatchOrdinary: index === 0,
      eligibleStationIds: [],
      reasons: [
        [],
        [{ code: 'pool_held', message: 'This pool is on hold.' }],
        [{ code: 'qualification_pending', message: 'A qualifying pool order awaits review.' }],
      ][index]!,
    })),
  };
  Object.assign(overview, {
    operatorDispatch: desk,
    sharedDispatch: { active: 0, capacity: 2, overCapacity: 0 },
  });
  responses['eventOps.delivery.status'] = { configured: false };
  return { desk, unexpected };
}

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440]) {
    test(`shared queue explains a search miss and keeps queue help optional at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const { unexpected } = await fixture(page);
      await page.goto(`/operate/${PLAN_ID}`);
      await ready(page);
      const desk = page.getByRole('region', { name: 'TO match queue' });
      const call = desk.getByRole('button', { name: 'Call ordinary match' });
      const search = desk.getByRole('textbox', { name: 'Find a pairing' });
      const view = desk.getByRole('combobox', { name: 'Queue view' });
      const help = desk.getByRole('button', { name: 'How queue order works' });
      await expect(page.getByRole('tab', { name: 'Run matches' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(desk.getByRole('heading', { name: new RegExp(longAlias) })).toBeVisible();
      await expect(desk.getByText(/ · TO order$/)).toBeVisible();
      await expect(call).toBeEnabled();
      await expect(help).toHaveAttribute('aria-expanded', 'false');
      await page.screenshot({ path: testInfo.outputPath('queue-ready.png'), fullPage: true });

      await search.fill('nobody on this roster');
      await expect(desk.getByRole('status')).toHaveText(searchMiss);
      await expect(call).toHaveCount(0);
      await expect(desk.getByText(/qualifying pool order/)).toBeHidden();
      await view.focus();
      await page.keyboard.press('Tab');
      await expect(help).toBeFocused();
      await help.press('Enter');
      await expect(help).toHaveAttribute('aria-expanded', 'true');
      await expect(desk.getByText(/Suggested order groups pairings/)).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(
        (
          await new AxeBuilder({ page })
            .include('.ops-page')
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({
        path: testInfo.outputPath('queue-search-and-help.png'),
        fullPage: true,
      });
      await help.press('Space');
      await expect(help).toHaveAttribute('aria-expanded', 'false');
      await clearInput(search);
      await expect(call).toBeEnabled();

      await chooseOption(view, 'waiting');
      await expect(desk.getByText('This pool is on hold.', { exact: true })).toBeVisible();
      await expect(call).toBeDisabled();
      await search.fill('nobody on this roster');
      await expect(desk.getByRole('status')).toHaveText(searchMiss);
      await clearInput(search);
      await chooseOption(view, 'all');
      await expect(call).toHaveCount(2);
      expect(unexpected).toEqual([]);
    });
  }

test('shared queue distinguishes waiting, held and empty views', async ({ page }) => {
  const { desk, unexpected } = await fixture(page);
  const [readyPairing, waitingPairing, heldPairing] = desk.queue;
  const queue = page.getByRole('region', { name: 'TO match queue' });
  const view = queue.getByRole('combobox', { name: 'Queue view' });
  const status = queue.getByRole('status');
  const holds = queue.getByRole('button', { name: 'Held matches and unresolved opponents' });
  const open = () => page.goto(`/operate/${PLAN_ID}`);

  desk.queue = [waitingPairing!, heldPairing!];
  await open();
  await expect(status).toHaveText(
    'No pairings ready to call. Choose Waiting to see what is blocking them.',
  );
  await chooseOption(view, 'waiting');
  await expect(queue.getByText('This pool is on hold.', { exact: true })).toBeVisible();

  desk.queue = [readyPairing!];
  await open();
  await chooseOption(view, 'waiting');
  await expect(status).toHaveText(
    'No pairings waiting. Choose Ready to call to see available pairings.',
  );
  await expect(holds).toHaveCount(0);

  desk.queue = [heldPairing!];
  await open();
  await expect(status).toHaveText(
    'No pairings in the queue. Check Held matches and unresolved opponents.',
  );
  await holds.press('Enter');
  await expect(queue.getByText('A qualifying pool order awaits review.')).toBeVisible();

  desk.queue = [];
  await open();
  await chooseOption(view, 'all');
  await expect(status).toHaveText('No pairings in the queue.');
  await expect(holds).toHaveCount(0);
  expect(unexpected).toEqual([]);
});
