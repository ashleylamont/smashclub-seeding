import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { Command, Desk } from '../src/pages/admin/dispatchTypes';
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
  return { desk, overview, readyMatch: readyMatch!, unexpected, submissions, starts };
}

async function callFixture(page: Page, { applyOnSuccess = true } = {}) {
  const { desk, overview, readyMatch, unexpected } = await fixture(page);
  const pairing = desk.queue[0]!;
  const station = overview.stations.find(({ currentMatchId }) => !currentMatchId)!;
  desk.stations = [{ ...station, enabled: true, reserved: true, revision: 0 }];
  pairing.eligibleStationIds = [station.id];
  const commands: { planId: string; requestId: string; command: Command }[] = [];
  let release!: () => void;
  const delay = new Promise<void>((resolve) => {
    release = resolve;
  });
  let failure: string | undefined;
  const applyDispatch = (command: Extract<Command, { kind: 'dispatch' }>) => {
    Object.assign(readyMatch, {
      status: 'playing',
      started: !command.callOnly,
      called: Boolean(command.callOnly),
      stationId: command.stationId,
      callLocation: command.callLocation ?? null,
    });
    pairing.state = command.callOnly ? 'called' : 'playing';
    if (!command.stationId) {
      desk.active = 1;
      Object.assign(overview, { sharedDispatch: { active: 1, capacity: 2, overCapacity: 0 } });
    }
    desk.resourceRevision++;
  };
  await page.route('**/api/trpc/eventOps.live.command*', async (route) => {
    const batched = new URL(route.request().url()).searchParams.has('batch');
    const body = route.request().postDataJSON();
    const input = batched ? body[0] : body;
    commands.push(input);
    await delay;
    const error = failure;
    failure = undefined;
    if (!error && applyOnSuccess) applyDispatch(input.command);
    const response = error
      ? { error: { message: error, code: -32603, data: { httpStatus: 500 } } }
      : { result: { data: { status: 'approved' } } };
    await route.fulfill({ json: batched ? [response] : response });
  });
  const queue = page.getByRole('region', { name: 'TO match queue' });
  const source = queue.locator('.dispatch-list article').filter({ hasText: longAlias });
  return {
    commands,
    release,
    failNext: (message: string) => {
      failure = message;
    },
    applyDispatch,
    readyMatch,
    station,
    queue,
    source,
    call: source.getByRole('button', { name: 'Call ordinary match' }),
    pending: source.getByRole('button', { name: 'Calling ordinary match…' }),
    search: queue.getByRole('textbox', { name: 'Find a pairing' }),
    receipt: queue.locator('[aria-live="polite"]').filter({ hasText: /^(Called|Started) / }),
    unexpected,
  };
}

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test(`ordinary call confirms the pairing and restores queue focus at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const {
        commands,
        release,
        readyMatch,
        queue,
        source,
        call,
        pending,
        search,
        receipt,
        unexpected,
      } = await callFixture(page);
      await page.goto(`/operate/${PLAN_ID}?view=run`);
      const location = source.getByRole('textbox', { name: 'Call location (optional)' });
      const heading = queue.getByRole('heading', { name: 'Pairings', exact: true });
      const run = page.getByRole('tab', { name: 'Run matches' });
      const locationLabel =
        width === 390 ? 'Opposite the windows beside the tournament registration desk' : '';
      await search.fill('Alexandria');
      await location.fill(locationLabel);
      await page.keyboard.press('Tab');
      await expect(call).toBeFocused();
      await page.keyboard.press('Enter');
      await expect.poll(() => commands.length).toBe(1);
      await expect(pending).toBeFocused();
      await expect(pending).toBeDisabled();
      await expect(receipt).toHaveCount(0);
      await page.keyboard.press('Enter');
      await page.keyboard.press('Space');
      await ready(page);
      await pending.evaluate((button) => button.scrollIntoView({ block: 'center' }));
      await page.screenshot({ path: testInfo.outputPath('ordinary-call-pending.png') });

      release();
      await expect(source).toHaveCount(0);
      await expect(receipt).toHaveCount(1);
      await expect(receipt).toContainText(`Called ${longAlias} vs ${readyMatch.player2Name}`);
      const calledLocation = locationLabel || 'Any available ordinary setup';
      await expect(receipt).toContainText(calledLocation);
      await expect(receipt).toBeInViewport();
      await expect(heading).toBeFocused();
      await expect(run).toHaveAttribute('aria-selected', 'true');
      const active = queue.getByRole('article').filter({ hasText: longAlias });
      await expect(active.getByRole('button', { name: 'Mark playing' })).toBeEnabled();
      await expect(active).toContainText('Called');
      await expect(queue.getByText('1 / 2 in use')).toBeVisible();
      await expect(commands).toEqual([
        {
          planId: PLAN_ID,
          requestId: expect.any(String),
          command: {
            kind: 'dispatch',
            matchId: readyMatch.id,
            stationId: null,
            expectedRevision: readyMatch.revision,
            expectedResourceRevision: 12,
            expectedOrdinaryCapacity: 2,
            callLocation: locationLabel || null,
            callOnly: true,
          },
        },
      ]);
      await ready(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(
        (
          await new AxeBuilder({ page })
            .include('.ops-page')
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath('ordinary-call-confirmed.png') });
      await page.keyboard.press('Tab');
      await expect(queue.getByRole('button', { name: 'Keyboard shortcuts' })).toBeFocused();
      await expect(search).toHaveValue('Alexandria');
      const capacity = queue.getByRole('button', { name: 'Capacity and named stations' });
      await capacity.press('Enter');
      await expect(capacity).toHaveAttribute('aria-expanded', 'true');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({
        path: testInfo.outputPath('ordinary-call-full-page.png'),
        fullPage: true,
      });
      expect(unexpected).toEqual([]);
    });

test('successful ordinary call leaves focus in a queue filter that replaced its source', async ({
  page,
}) => {
  const { call, commands, release, receipt, search, source, unexpected } = await callFixture(page);
  await page.goto(`/operate/${PLAN_ID}`);
  await call.press('Enter');
  await expect.poll(() => commands.length).toBe(1);
  await search.fill('changed while the call was pending');
  await expect(source).toHaveCount(0);
  await expect(search).toBeFocused();
  release();
  await expect(receipt).toHaveCount(1);
  await expect(search).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Run matches' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(unexpected).toEqual([]);
});

test('a failed ordinary call retains keyboard focus and can retry the same request', async ({
  page,
}) => {
  const { call, commands, release, failNext, queue, receipt, source, unexpected } =
    await callFixture(page);
  await page.goto(`/operate/${PLAN_ID}`);
  const location = source.getByRole('textbox', { name: 'Call location (optional)' });
  await location.fill('Near the front desk');
  failNext('The queue connection was interrupted.');
  await call.press('Enter');
  release();
  await expect(queue.getByRole('alert')).toContainText('The queue connection was interrupted.');
  await expect(receipt).toHaveCount(0);
  await expect(call).toBeFocused();
  await expect(location).toHaveValue('Near the front desk');
  await page.keyboard.press('Enter');
  await expect(receipt).toHaveCount(1);
  expect(commands).toHaveLength(2);
  expect(commands[1]).toEqual(commands[0]);
  expect(unexpected).toEqual([]);
});

test('a named station start confirms the station and leaves ordinary capacity free', async ({
  page,
}) => {
  const { commands, release, queue, receipt, source, station, unexpected } =
    await callFixture(page);
  await page.goto(`/operate/${PLAN_ID}`);
  await chooseOption(source.getByRole('combobox', { name: 'Named station' }), station.id);
  await source.getByRole('button', { name: 'Start named station' }).press('Enter');
  const pending = source.getByRole('button', { name: 'Starting named station…' });
  await expect(pending).toBeFocused();
  await expect(pending).toBeDisabled();
  await expect(receipt).toHaveCount(0);
  release();
  await expect(queue.getByRole('article').filter({ hasText: longAlias })).toContainText(
    `Playing · ${station.name}`,
  );
  await expect(queue.getByText('0 / 2 in use')).toBeVisible();
  await expect(receipt).toContainText(`Started ${longAlias}`);
  await expect(receipt).toContainText(station.name);
  await expect(queue.getByRole('heading', { name: 'Pairings', exact: true })).toBeFocused();
  expect(commands).toHaveLength(1);
  expect(commands[0]!.command).toMatchObject({
    kind: 'dispatch',
    stationId: station.id,
    callOnly: false,
  });
  expect(unexpected).toEqual([]);
});

test('a call made by another organiser updates the queue without a local receipt or focus move', async ({
  page,
}) => {
  const { applyDispatch, commands, readyMatch, receipt, search, source, unexpected } =
    await callFixture(page);
  await page.goto(`/operate/${PLAN_ID}`);
  await search.fill('Alexandria');
  await expect(source).toBeVisible();
  await expect(search).toBeFocused();
  await ready(page);
  const scrollBefore = await page.evaluate(() => scrollY);
  applyDispatch({
    kind: 'dispatch',
    matchId: readyMatch.id,
    stationId: null,
    expectedRevision: readyMatch.revision,
    expectedResourceRevision: 12,
    callOnly: true,
  });
  await expect(source).toHaveCount(0);
  await expect(receipt).toHaveCount(0);
  await expect(search).toBeFocused();
  expect(await page.evaluate(() => scrollY)).toBe(scrollBefore);
  expect(commands).toEqual([]);
  expect(unexpected).toEqual([]);
});

test('a later poll does not restore focus when a successful call left its button in place', async ({
  page,
}) => {
  const { applyDispatch, call, commands, queue, receipt, release, source, unexpected } =
    await callFixture(page, { applyOnSuccess: false });
  await page.goto(`/operate/${PLAN_ID}`);
  await call.press('Enter');
  release();
  await expect(receipt).toHaveCount(1);
  await expect(call).toBeFocused();
  const command = commands[0]?.command;
  if (command?.kind !== 'dispatch') throw new Error('Expected an ordinary call command');
  applyDispatch(command);
  await expect(source).toHaveCount(0);
  await expect(queue.getByRole('heading', { name: 'Pairings', exact: true })).not.toBeFocused();
  expect(unexpected).toEqual([]);
});

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

    test(`shared queue explains interrupted actions at ${width}px in ${theme}`, async ({
      page,
      context,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const { unexpected } = await fixture(page);
      await page.goto(`/operate/${PLAN_ID}`);
      await ready(page);
      const desk = page.getByRole('region', { name: 'TO match queue' });
      const row = desk.getByRole('article').filter({ hasText: longAlias });
      const location = row.getByRole('textbox', { name: 'Call location (optional)' });
      const call = row.getByRole('button', { name: 'Call ordinary match' });
      const score = row.getByRole('button', { name: 'Score / details' });
      const reorder = row.getByRole('button', { name: 'Move down' });
      const notice = desk.getByText(/Calling, scoring and reordering are paused/);
      const alert = page.getByRole('alert').filter({ hasText: 'Live updates interrupted.' });
      const tabs = page.getByRole('tablist', { name: 'Event workspace' });
      await expect(notice).toHaveCount(0);
      await expect(score).toBeEnabled();
      await expect(reorder).toBeEnabled();
      await location.fill('Near the front desk');
      await location.press('Tab');
      await expect(call).toBeFocused();
      await call.evaluate((button) => button.scrollIntoView({ block: 'center' }));

      await context.setOffline(true);
      await page.evaluate(() => window.dispatchEvent(new Event('offline')));
      await expect(call).toBeDisabled();
      await expect(score).toBeDisabled();
      await expect(reorder).toBeDisabled();
      await expect(alert).toHaveCount(1);
      await expect(alert).not.toBeInViewport();
      await expect(notice).toBeInViewport();
      await expect
        .poll(async () => (await notice.boundingBox())!.y)
        .toBeGreaterThanOrEqual((await tabs.boundingBox())!.y + (await tabs.boundingBox())!.height);
      await expect(desk.getByRole('alert')).toHaveCount(0);
      await expect(desk.getByRole('status').filter({ hasText: 'reordering' })).toHaveCount(0);
      await expect(location).toHaveValue('Near the front desk');
      const help = desk.getByRole('button', { name: 'How queue order works' });
      await help.press('Enter');
      await expect(help).toHaveAttribute('aria-expanded', 'true');
      await expect(desk.getByText(/Suggested order groups pairings/)).toBeVisible();
      await call.evaluate((button) => button.scrollIntoView({ block: 'center' }));
      await ready(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(
        (
          await new AxeBuilder({ page })
            .include('.ops-page')
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath('queue-interrupted.png') });
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: testInfo.outputPath('queue-full-page.png'), fullPage: true });

      await context.setOffline(false);
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await expect(notice).toHaveCount(0);
      await expect(alert).toHaveCount(0);
      await expect(call).toBeEnabled();
      await expect(score).toBeEnabled();
      await expect(reorder).toBeEnabled();
      await expect(location).toHaveValue('Near the front desk');
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
      await page.keyboard.press('Control+Shift+F7');
      await expect(close).toBeFocused();
      await expect(help.getByText('Find a pairing', { exact: true })).toBeVisible();
      await expect(help.getByText('Focus score editor')).toBeVisible();
      await expect(help.getByText('Go to the ready queue')).toBeVisible();
      await expect(help.getByText('Ctrl + Shift + F9')).toBeVisible();
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

      await page.keyboard.press('Control+Shift+F8');
      await expect(trigger).toBeFocused();
      await page.keyboard.press('Control+Shift+F7');
      await expect(search).toBeFocused();
      await search.fill('Alexandria');
      await page.keyboard.press('Control+Shift+F9');
      await expect(search).toBeFocused();
      await view.press('Enter');
      const menu = page.getByRole('listbox');
      const selectedOption = menu.getByRole('option', { name: 'Ready to call' });
      await expect(selectedOption).toBeFocused();
      await page.keyboard.press('Control+Shift+F7');
      await expect(selectedOption).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(view).toBeFocused();

      const row = queue.locator('.dispatch-list article').filter({ hasText: longAlias });
      await row.getByRole('button', { name: 'Score / details' }).press('Enter');
      await expect(page.getByText('Showing the selected match.')).toBeFocused();
      await page.keyboard.press('Control+Shift+F8');
      const form = page.getByRole('form', {
        name: 'Confirm the final result and finish this match',
      });
      const score = form.getByRole('spinbutton', { name: longAlias });
      await expect(form).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(score).toBeFocused();
      await score.fill('');
      await page.keyboard.press('Control+Shift+F7');
      await expect(score).toBeFocused();
      await expect(score).toHaveValue('');

      await chooseOption(view, 'waiting');
      const readyQueue = page.getByRole('button', { name: 'Go to ready queue' });
      await expect(readyQueue).toHaveAttribute('aria-keyshortcuts', 'Control+Shift+F9');
      await readyQueue.focus();
      await page.keyboard.press('Control+Shift+Digit5');
      await expect(readyQueue).toBeFocused();
      await page.keyboard.press('Control+Shift+F9');
      await expect(pairings).toBeFocused();
      await expect(view).toHaveAttribute('data-value', 'ready');
      await expect(search).toHaveValue('Alexandria');
      await expect(row).toBeVisible();
      await page.keyboard.press('Control+Shift+F8');
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
      await page.keyboard.press('Control+Shift+F7');
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
  await page.keyboard.press('Control+Shift+F8');
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
