import { readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { Command, Desk } from '../src/pages/admin/dispatchTypes';
import { chooseOption } from '../test-support/controls';
import { bracketCaptureOptions, mockEvent, PLAN_ID, ready } from './fixtures';

const captureStyle = readFileSync(bracketCaptureOptions.stylePath, 'utf8');
const alias = 'Alexandria with a long tournament alias from Western Sydney';

async function stageFixture(page: Page) {
  const { overview, unexpected } = await mockEvent(page, { role: 'admin', idle: true });
  const station = overview.stations[0]!;
  Object.assign(station, { name: 'Stage', currentMatchId: null, status: 'free' });
  const [match, waiting] = overview.matches.filter((row) => row.status === 'ready');
  Object.assign(match!, { player1Name: alias, label: 'Semi-final 1' });
  Object.assign(waiting!, { label: 'Awaiting score review' });
  const deskStation = {
    id: station.id,
    name: station.name,
    enabled: true,
    reserved: true,
    revision: 0,
    currentMatchId: null as string | null,
  };
  const row: Desk['queue'][number] = {
    matchId: match!.id,
    state: 'ready',
    waitingSince: 0,
    downstream: 0,
    reason: 'TO order',
    canStart: true,
    canDispatchOrdinary: false,
    eligibleStationIds: [station.id],
    reasons: [],
  };
  const desk: Desk = {
    mode: 'shared',
    capacity: 1,
    active: 1,
    overCapacity: 0,
    resourceRevision: 12,
    queueRevision: 0,
    stations: [deskStation],
    entrants: [],
    pools: [],
    queue: [
      row,
      {
        ...row,
        matchId: waiting!.id,
        state: 'blocked',
        canStart: false,
        eligibleStationIds: [],
        reasons: [
          { code: 'score_review_pending', message: 'This match has a score awaiting TO review.' },
        ],
      },
    ],
  };
  overview.reports = [];
  Object.assign(overview, {
    operatorDispatch: desk,
    sharedDispatch: { active: 1, capacity: 1, overCapacity: 0 },
    twitchBroadcast: { revision: 0, promotion: null },
  });
  const url = `/operate/${PLAN_ID}?view=broadcast&station=${station.id}`;
  const panel = page.getByRole('tabpanel', { name: 'Broadcast', exact: true });
  const picker = panel.getByRole('combobox', { name: 'Ready pairing' });
  const start = panel.getByRole('button', { name: 'Start on Stage', exact: true });
  return { desk, deskStation, row, station, match: match!, unexpected, url, panel, picker, start };
}

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test(`Broadcast offers only eligible Stage pairings at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const { match, panel, picker, start, url, unexpected } = await stageFixture(page);
      await page.goto(url);
      await expect(picker).toContainText('Choose a pairing');
      await expect(start).toBeDisabled();
      await picker.press('Enter');
      const menu = page.getByRole('listbox');
      await expect(menu.getByRole('option')).toHaveCount(2);
      await expect(menu.getByText('Awaiting score review', { exact: false })).toHaveCount(0);
      const choice = menu.getByRole('option', { name: /Semi-final 1.*Alexandria/ });
      await choice.press('Enter');
      await expect(picker).toHaveAttribute('data-value', match.id);
      await expect(start).toBeEnabled();
      await expect(start).toHaveAccessibleDescription(`${alias} vs ${match.player2Name}`);
      await expect(
        panel.getByText(`${alias} vs ${match.player2Name}`, { exact: true }),
      ).toBeVisible();
      await ready(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
          .violations,
      ).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath('broadcast-start.png'),
        fullPage: true,
        style: captureStyle,
      });
      expect(unexpected).toEqual([]);
    });

test('Broadcast requires a fresh choice after the queue or resource changes', async ({ page }) => {
  const { desk, row, match, panel, picker, start, url, unexpected } = await stageFixture(page);
  await page.goto(url);
  await chooseOption(picker, match.id);
  desk.resourceRevision++;
  await expect(start).toBeDisabled();
  await expect(
    panel.getByText('The queue or station setup changed. Choose a pairing again.'),
  ).toBeVisible();
  await chooseOption(picker, match.id);
  match.revision++;
  await expect(start).toBeDisabled();
  await expect(picker).toHaveAttribute('data-value', '');
  await chooseOption(picker, match.id);
  row.state = 'blocked';
  await expect(panel.getByText('No pairings are ready for this station.')).toBeVisible();
  row.state = 'ready';
  await expect(picker).toHaveAttribute('data-value', '');
  await expect(start).toBeDisabled();
  expect(unexpected).toEqual([]);
});

test('Broadcast keeps occupied, disabled and station-only setup interlocks', async ({ page }) => {
  const { desk, deskStation, station, match, panel, picker, url, unexpected } =
    await stageFixture(page);
  await page.goto(url);
  await expect(picker).toBeVisible();
  deskStation.enabled = false;
  await expect(picker).toHaveCount(0);
  deskStation.enabled = true;
  await expect(picker).toBeVisible();
  desk.mode = 'station';
  await expect(picker).toHaveCount(0);
  desk.mode = 'shared';
  await expect(picker).toBeVisible();

  station.currentMatchId = 'unresolved-occupancy';
  await expect(picker).toHaveCount(0);
  Object.assign(match, { status: 'playing', started: false, called: true, stationId: station.id });
  station.currentMatchId = match.id;
  deskStation.currentMatchId = match.id;
  await expect(panel.getByText('Waiting for play to start')).toBeVisible();
  await expect(picker).toHaveCount(0);
  expect(unexpected).toEqual([]);
});

test('Run retries the exact Broadcast start after a lost response', async ({ page }) => {
  const { desk, deskStation, row, station, match, panel, picker, start, url, unexpected } =
    await stageFixture(page);
  const requests: { planId: string; requestId: string; command: Command }[] = [];
  let loseResponse!: () => void;
  const held = new Promise<void>((resolve) => {
    loseResponse = resolve;
  });
  await page.route('**/api/trpc/eventOps.live.command*', async (route) => {
    const batch = new URL(route.request().url()).searchParams.has('batch');
    const body = route.request().postDataJSON();
    requests.push(batch ? body[0] : body);
    if (requests.length === 1) {
      await held;
      await route.abort('failed');
      return;
    }
    Object.assign(match, { status: 'playing', started: true, stationId: station.id });
    station.currentMatchId = match.id;
    deskStation.currentMatchId = match.id;
    row.state = 'playing';
    desk.resourceRevision++;
    const result = { result: { data: {} } };
    await route.fulfill({ json: batch ? [result] : result });
  });
  try {
    await page.goto(url);
    await chooseOption(picker, match.id);
    await start.press('Enter');
    await expect.poll(() => requests.length).toBe(1);
    const run = page.getByRole('tabpanel', { name: 'Run matches', exact: true });
    await page.getByRole('tab', { name: 'Run matches', exact: true }).press('Enter');
    const readyRow = run.locator(`[data-match-id="${match.id}"]`);
    const retry = readyRow.getByRole('button', { name: 'Start named station', exact: true });
    await expect(retry).toBeDisabled();
    loseResponse();
    await expect(run.getByRole('alert')).toBeVisible();
    await chooseOption(readyRow.getByRole('combobox', { name: 'Named station' }), station.id);
    await retry.press('Enter');
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[0]).toMatchObject({
      planId: PLAN_ID,
      requestId: expect.any(String),
      command: {
        kind: 'dispatch',
        matchId: match.id,
        stationId: station.id,
        expectedRevision: match.revision,
        expectedResourceRevision: 12,
        callOnly: false,
      },
    });
    expect(requests[1]).toEqual(requests[0]);
    await page.getByRole('tab', { name: 'Broadcast', exact: true }).press('Enter');
    await expect(panel.getByRole('button', { name: 'Finish match', exact: true })).toBeVisible();
    await expect(picker).toHaveCount(0);
    expect(unexpected).toEqual([]);
  } finally {
    loseResponse();
  }
});
