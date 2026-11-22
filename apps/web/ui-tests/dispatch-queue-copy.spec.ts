import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { Desk } from '../src/pages/admin/dispatchTypes';
import { chooseOption, clearInput } from '../test-support/controls';
import { mockEvent, PLAN_ID, ready } from './fixtures';

const longAlias = 'Alexandria with a long tournament alias from Western Sydney';
const searchMiss = 'No pairings match this search. Clear the search to see this view.';

async function fixture(page: Page) {
  const { overview, responses, unexpected, submissions, starts } = await mockEvent(page, {
    role: 'admin',
  });
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
  return { desk, unexpected, submissions, starts };
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

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440]) {
    test(`shared desk shortcuts keep focus and drafts at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const { unexpected, submissions, starts } = await fixture(page);
      await page.goto(`/operate/${PLAN_ID}`);
      await ready(page);
      const queue = page.getByRole('region', { name: 'TO match queue' });
      const pairings = queue.getByRole('heading', { name: 'Pairings', exact: true });
      const search = queue.getByRole('textbox', { name: 'Find a pairing' });
      const view = queue.getByRole('combobox', { name: 'Queue view' });
      const trigger = queue.getByRole('button', { name: 'Keyboard shortcuts' });
      const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
      await trigger.press('Enter');
      const close = help.getByRole('button', { name: 'Close dialog' });
      await expect(close).toBeFocused();
      await page.keyboard.press('Control+Shift+Digit1');
      await expect(close).toBeFocused();
      await expect(help.getByText('Find a pairing', { exact: true })).toBeVisible();
      await expect(help.getByText('Focus score editor')).toBeVisible();
      await expect(help.getByText('Go to the ready queue')).toBeVisible();
      await expect(help.getByText('Ctrl + Shift + 5')).toBeVisible();
      await ready(page);
      expect(
        (await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations,
      ).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath('shortcuts-help.png'),
        animations: 'disabled',
      });
      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();

      await page.keyboard.press('Control+Shift+Digit2');
      await expect(trigger).toBeFocused();
      await page.keyboard.press('Control+Shift+Digit1');
      await expect(search).toBeFocused();
      await search.fill('Alexandria');
      await page.keyboard.press('Control+Shift+Digit5');
      await expect(search).toBeFocused();
      await view.press('Enter');
      const menu = page.getByRole('listbox');
      const selectedOption = menu.getByRole('option', { name: 'Ready to call' });
      await expect(selectedOption).toBeFocused();
      await page.keyboard.press('Control+Shift+Digit1');
      await expect(selectedOption).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(view).toBeFocused();

      const row = queue.locator('.dispatch-list article').filter({ hasText: longAlias });
      await row.getByRole('button', { name: 'Score / details' }).press('Enter');
      await expect(page.getByText('Showing the selected match.')).toBeFocused();
      await page.keyboard.press('Control+Shift+Digit2');
      const form = page.getByRole('form', {
        name: 'Confirm the final result and finish this match',
      });
      const score = form.getByRole('spinbutton', { name: longAlias });
      await expect(form).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(score).toBeFocused();
      await score.fill('');
      await page.keyboard.press('Control+Shift+Digit1');
      await expect(score).toBeFocused();
      await expect(score).toHaveValue('');

      await chooseOption(view, 'waiting');
      const readyQueue = page.getByRole('button', { name: 'Go to ready queue' });
      await expect(readyQueue).toHaveAttribute('aria-keyshortcuts', 'Control+Shift+5');
      await readyQueue.focus();
      await page.keyboard.press('Control+Shift+Digit3');
      await expect(readyQueue).toBeFocused();
      await page.keyboard.press('Control+Shift+Digit5');
      await expect(pairings).toBeFocused();
      await expect(view).toHaveAttribute('data-value', 'ready');
      await expect(search).toHaveValue('Alexandria');
      await expect(row).toBeVisible();
      await page.keyboard.press('Control+Shift+Digit2');
      await expect(form).toBeFocused();
      await expect(score).toHaveValue('');
      await expect(form.getByRole('button', { name: 'Confirm result' })).toBeDisabled();
      const tabs = page.getByRole('tablist', { name: 'Event workspace' });
      await expect
        .poll(async () => (await form.boundingBox())!.y)
        .toBeGreaterThanOrEqual((await tabs.boundingBox())!.y + (await tabs.boundingBox())!.height);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await page.screenshot({
        path: testInfo.outputPath('shortcuts-score.png'),
        animations: 'disabled',
      });
      expect(
        (
          await new AxeBuilder({ page })
            .include('.ops-page')
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);

      await readyQueue.press('Enter');
      await expect(pairings).toBeFocused();
      const players = tabs.getByRole('tab', { name: 'Players' });
      await players.press('Enter');
      await expect(players).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('Control+Shift+Digit1');
      await expect(players).toBeFocused();
      await expect(search).toBeHidden();
      await tabs.getByRole('tab', { name: 'Run matches' }).press('Enter');
      await expect(search).toHaveValue('Alexandria');
      await expect(score).toHaveValue('');
      expect(starts).toEqual([]);
      expect(submissions).toEqual([]);
      expect(unexpected).toEqual([]);
    });
  }

test('shared desk shortcut reveals the score title and first field in a short window', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 500 });
  const { unexpected, submissions } = await fixture(page);
  await page.goto(`/operate/${PLAN_ID}`);
  const queue = page.getByRole('region', { name: 'TO match queue' });
  const row = queue.locator('.dispatch-list article').filter({ hasText: longAlias });
  await row.getByRole('button', { name: 'Score / details' }).press('Enter');
  await expect(page.getByText('Showing the selected match.')).toBeFocused();
  await page.keyboard.press('Control+Shift+Digit2');
  const title = 'Confirm the final result and finish this match';
  const form = page.getByRole('form', { name: title });
  await expect(form).toBeFocused();
  const tabs = page.getByRole('tablist', { name: 'Event workspace' });
  const score = form.getByRole('spinbutton', { name: longAlias });
  await ready(page);
  await expect
    .poll(async () => {
      const tabBar = (await tabs.boundingBox())!;
      const titleBox = (await form.getByText(title, { exact: true }).boundingBox())!;
      const scoreBox = (await score.boundingBox())!;
      return {
        titleBelowTabs: titleBox.y >= tabBar.y + tabBar.height,
        fieldInView: scoreBox.y >= tabBar.y + tabBar.height && scoreBox.y + scoreBox.height <= 500,
      };
    })
    .toEqual({ titleBelowTabs: true, fieldInView: true });
  await page.screenshot({
    path: testInfo.outputPath('short-window-score.png'),
    animations: 'disabled',
  });
  await page.keyboard.press('Tab');
  await expect(score).toBeFocused();
  expect(submissions).toEqual([]);
  expect(unexpected).toEqual([]);
});
