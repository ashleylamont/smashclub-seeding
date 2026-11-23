import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { Command, Desk } from '../src/pages/admin/dispatchTypes';
import { mockEvent, PLAN_ID, ready } from './fixtures';

async function capacityForm(page: Page, named = false) {
  const { overview, responses, unexpected } = await mockEvent(page, { role: 'player', idle: true });
  Object.assign(overview.plan, { bracketMode: 'native', liveOwned: true });
  const matches = overview.matches
    .filter(({ status }) => status === 'ready')
    .slice(0, named ? 3 : 2);
  const station = { ...overview.stations[0]!, enabled: true, reserved: true, revision: 0 };
  station.name = 'Rehearsal stage with a long station name';
  if (named) station.currentMatchId = matches[2]!.id;
  for (const [index, match] of matches.entries())
    Object.assign(match, {
      status: 'playing',
      started: index > 0,
      stationId: index === 2 ? station.id : null,
      player1Name: 'Alexandria with a long tournament alias from Western Sydney',
    });
  const desk: Desk = {
    mode: 'shared',
    capacity: 3,
    active: 2,
    overCapacity: 0,
    resourceRevision: 12,
    queueRevision: 0,
    stations: named ? [station] : [],
    entrants: [],
    pools: [],
    queue: matches.map((match, index) => ({
      matchId: match.id,
      state: index === 0 ? 'called' : 'playing',
      waitingSince: 0,
      downstream: 0,
      reason: 'Playing',
      canStart: false,
      canDispatchOrdinary: false,
      eligibleStationIds: [],
      reasons: [],
    })),
  };
  const shared = { capacity: 3, active: 2, overCapacity: 0 };
  Object.assign(overview, { operatorDispatch: desk, sharedDispatch: shared });
  responses['eventOps.delivery.status'] = { configured: false };
  const commands: Command[] = [];
  await page.route('**/api/trpc/eventOps.live.command*', async (route) => {
    const batched = new URL(route.request().url()).searchParams.has('batch');
    const post = route.request().postDataJSON();
    const { command } = batched ? post[0] : post;
    commands.push(command);
    if (command.kind === 'configureDispatch') {
      const overCapacity = Math.max(0, desk.active - command.capacity);
      Object.assign(desk, { capacity: command.capacity, overCapacity });
      Object.assign(shared, { capacity: command.capacity, overCapacity });
      desk.resourceRevision++;
    }
    const result = { result: { data: { status: 'approved' } } };
    await route.fulfill({ json: batched ? [result] : result });
  });
  await page.goto(`/operate/${PLAN_ID}?view=run`);
  await ready(page);
  await page
    .getByRole('button', { name: 'Capacity and named stations', exact: true })
    .press('Enter');
  const setup = page.locator('#station-controls');
  return {
    setup,
    capacity: setup.getByRole('spinbutton', { name: 'Ordinary concurrent matches' }),
    save: setup.getByRole('button', { name: 'Save capacity' }),
    warning: setup.getByRole('status').filter({ hasText: /above the proposed ordinary limit/ }),
    commands,
    unexpected,
    station,
    desk,
    shared,
  };
}

for (const theme of ['dark', 'light'] as const) {
  for (const width of [390, 1440]) {
    test(`shared capacity warns before saving below active usage at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const { setup, capacity, save, warning, commands, unexpected } = await capacityForm(page);
      await capacity.fill('2');
      await expect(warning).toHaveCount(0);
      await capacity.fill('1');
      await expect(warning).toContainText('1 match above the proposed ordinary limit.');
      await expect(warning).toContainText('Existing calls and matches in play will continue.');
      await expect(warning).toContainText(
        'New ordinary calls will wait until capacity is available.',
      );
      await expect(save).toHaveAccessibleDescription(/1 match above the proposed ordinary limit/);
      await expect(save).toBeEnabled();
      expect(commands).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(
        (
          await new AxeBuilder({ page })
            .include('#station-controls')
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      await setup.screenshot({ path: testInfo.outputPath('before-saving-below-active.png') });
      await save.press('Enter');
      await expect
        .poll(() => commands)
        .toEqual([
          {
            kind: 'configureDispatch',
            capacity: 1,
            reservedStationIds: [],
            expectedResourceRevision: 12,
          },
        ]);
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
      await expect(warning).toHaveCount(0);
      await expect(page.getByRole('region', { name: 'Shared capacity' })).toContainText(
        '1 above the new cap.',
      );
      expect(unexpected).toEqual([]);
    });
  }
}

test('reloads capacity before saving when the ordinary occupied count changes', async ({
  page,
}) => {
  const { setup, capacity, save, warning, commands, desk, shared } = await capacityForm(page);
  await capacity.fill('1');
  await expect(warning).toContainText('1 match above the proposed ordinary limit.');
  desk.active = 1;
  desk.resourceRevision++;
  shared.active = 1;
  const reload = setup.getByRole('button', { name: 'Load current capacity' });
  await expect(reload).toBeVisible({ timeout: 8000 });
  await expect(warning).toHaveCount(0);
  await expect(save).toBeDisabled();
  await reload.press('Enter');
  await capacity.fill('1');
  await expect(warning).toHaveCount(0);
  await capacity.fill('0');
  await expect(warning).toContainText('1 match above the proposed ordinary limit.');
  expect(commands).toEqual([]);
});

test('includes an occupied station when its reservation would be removed', async ({ page }) => {
  const { setup, station, capacity, warning, commands } = await capacityForm(page, true);
  await capacity.fill('2');
  await expect(warning).toHaveCount(0);
  const reservation = setup.getByRole('checkbox', { name: station.name });
  await reservation.uncheck();
  await expect(warning).toContainText('1 match above the proposed ordinary limit.');
  await capacity.fill('1');
  await expect(warning).toContainText('2 matches above the proposed ordinary limit.');
  await reservation.check();
  await expect(warning).toContainText('1 match above the proposed ordinary limit.');
  expect(commands).toEqual([]);
});
