import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { Command, Desk } from '../src/pages/admin/dispatchTypes';
import { mockEvent, PLAN_ID, ready } from './fixtures';

async function activeStage(page: Page) {
  const { overview, unexpected } = await mockEvent(page, { role: 'admin' });
  const match = overview.matches.find((item) => item.status === 'playing')!;
  const station = overview.stations.find((item) => item.currentMatchId === match.id)!;
  Object.assign(match, {
    player1Name: 'Alexandria with a long tournament alias from Western Sydney',
    started: true,
    score1: 1,
    score2: 0,
    liveScore1: 1,
    liveScore2: 0,
    resourceRevision: 12,
  });
  const desk: Desk = {
    mode: 'shared',
    capacity: 1,
    active: 0,
    overCapacity: 0,
    resourceRevision: 12,
    queueRevision: 0,
    stations: [{ ...station, enabled: true, reserved: true, revision: 0 }],
    entrants: [],
    pools: [],
    queue: [
      {
        matchId: match.id,
        state: 'playing',
        waitingSince: 0,
        downstream: 0,
        reason: 'Playing',
        canStart: false,
        canDispatchOrdinary: false,
        eligibleStationIds: [],
        reasons: [],
      },
    ],
  };
  Object.assign(overview, {
    operatorDispatch: desk,
    sharedDispatch: { active: 0, capacity: 1, overCapacity: 0 },
  });
  overview.reports = [];
  const active = page.locator(`article[data-match-id="${match.id}"]`);
  const broadcastUrl = `/operate/${PLAN_ID}?view=broadcast&station=${station.id}`;
  const details = async () => {
    await page.getByRole('tab', { name: 'Run matches', exact: true }).press('Enter');
    await active.getByRole('button', { name: 'Score / details', exact: true }).press('Enter');
  };
  const card = page.locator('article.ops-match:visible');
  const release = card.getByRole('button', { name: 'Release capacity', exact: true });
  return { match, station, desk, unexpected, broadcastUrl, details, card, release, active };
}

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test(`shared match cards confirm a Stage release at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const { broadcastUrl, details, card, release, unexpected } = await activeStage(page);
      await page.goto(broadcastUrl);
      await ready(page);
      const dialog = page.getByRole('alertdialog', { name: 'Confirm action' });
      for (const surface of ['broadcast', 'details'] as const) {
        if (surface === 'details') await details();
        await expect(card.locator('.ops-contestant b')).toHaveText(['1', '0']);
        await release.press('Enter');
        await expect(dialog).toHaveAccessibleDescription(
          /Actual play and live scores remain recorded/,
        );
        await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
        expect(
          (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
            .violations,
        ).toEqual([]);
        await page.screenshot({ path: testInfo.outputPath(`${surface}-confirm.png`) });
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
        await expect(release).toBeFocused();
      }
      expect(unexpected).toEqual([]);
    });

test('the match card release stays offline-safe and retries the same command from the active row', async ({
  page,
  context,
}) => {
  const { match, station, desk, broadcastUrl, card, release, active, unexpected } =
    await activeStage(page);
  const requests: { planId: string; requestId: string; command: Command }[] = [];
  let loseResponse!: () => void;
  const pendingResponse = new Promise<void>((resolve) => {
    loseResponse = resolve;
  });
  await page.route('**/api/trpc/eventOps.live.command*', async (route) => {
    const batch = new URL(route.request().url()).searchParams.has('batch');
    const body = route.request().postDataJSON();
    requests.push(batch ? body[0] : body);
    if (requests.length === 1) {
      await pendingResponse;
      await route.abort('failed');
      return;
    }
    const response = { result: { data: {} } };
    Object.assign(match, { status: 'ready', stationId: null });
    station.currentMatchId = null;
    desk.stations[0]!.currentMatchId = null;
    desk.queue[0]!.state = 'ready';
    await route.fulfill({ json: batch ? [response] : response });
  });
  try {
    await page.goto(broadcastUrl);
    const dialog = page.getByRole('alertdialog');
    const confirm = dialog.getByRole('button', { name: 'Confirm', exact: true });
    await release.press('Enter');
    // Simulate the browser losing connectivity while the operator reads the prompt.
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expect(page.getByText('Live updates interrupted.', { exact: false })).toBeAttached();
    await confirm.press('Enter');
    await expect(dialog).toBeHidden();
    await expect(release).toBeDisabled();
    expect(requests).toHaveLength(0);
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(release).toBeEnabled();
    await release.press('Enter');
    await confirm.press('Enter');
    await expect.poll(() => requests.length).toBe(1);
    await expect(card.getByRole('button', { name: 'Update live score' })).toBeDisabled();
    await expect(card.getByRole('button', { name: 'Finish match' })).toBeDisabled();
    await page.getByRole('tab', { name: 'Run matches', exact: true }).press('Enter');
    const retry = active.getByRole('button', { name: 'Release capacity', exact: true });
    await expect(retry).toBeDisabled();
    loseResponse();
    const queue = page.getByRole('region', { name: 'TO match queue', exact: true });
    await expect(queue.getByRole('alert')).toBeVisible();
    await retry.press('Enter');
    await confirm.press('Enter');
    await expect(retry).toHaveCount(0);
    expect(requests[0]).toEqual({
      planId: PLAN_ID,
      requestId: expect.any(String),
      command: {
        kind: 'matchControl',
        matchId: match.id,
        status: 'ready',
        stationId: null,
        reason: null,
        expectedRevision: match.revision,
        expectedResourceRevision: 12,
      },
    });
    expect(requests).toEqual([requests[0], requests[0]]);
    expect(unexpected).toEqual([]);
  } finally {
    loseResponse();
  }
});
