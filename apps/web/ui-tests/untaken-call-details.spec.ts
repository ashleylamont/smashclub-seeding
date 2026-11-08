import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { Desk } from '../src/pages/admin/dispatchTypes';
import { mockEvent, PLAN_ID, ready } from './fixtures';

async function capture(page: Page, path: string) {
  await page.evaluate(() => scrollTo(0, 0));
  await ready(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path, fullPage: true });
}

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test(`shared Run details distinguish call, play and result at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const { overview, unexpected } = await mockEvent(page, { role: 'admin', idle: true });
      const match = overview.matches.find((row) => row.status === 'ready')!;
      const initialRevision = match.revision;
      const initialProgress = match.progressRevision;
      const alias = 'Alexandria with a long tournament alias from Western Sydney';
      Object.assign(match, {
        player1Name: alias,
        status: 'playing',
        started: false,
        called: true,
        callLocation: 'Window setup',
        stationId: null,
        score1: null,
        score2: null,
        liveScore1: null,
        liveScore2: null,
        resourceRevision: 12,
      });
      const participant = overview.entrants.find((entrant) => entrant.id === match.player1Id)!;
      participant.name = alias;
      overview.reports = [];
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
            matchId: match.id,
            state: 'called',
            waitingSince: 0,
            downstream: 0,
            reason: 'Awaiting actual play',
            canStart: false,
            canDispatchOrdinary: false,
            eligibleStationIds: [],
            reasons: [],
          },
        ],
      };
      Object.assign(overview, {
        operatorDispatch: desk,
        sharedDispatch: { active: 1, capacity: 2, overCapacity: 0 },
      });
      const commands: unknown[] = [];
      const liveScores: unknown[] = [];
      const results: unknown[] = [];
      for (const operation of ['live.command', 'updateLiveScore', 'reportScore'] as const) {
        await page.route(`**/api/trpc/eventOps.${operation}*`, async (route) => {
          const batch = new URL(route.request().url()).searchParams.has('batch');
          const body = route.request().postDataJSON();
          const input = batch ? body[0] : body;
          if (operation === 'live.command') {
            commands.push(input.command);
            Object.assign(match, { started: true, called: false, resourceRevision: 13 });
            desk.resourceRevision = 13;
            desk.queue[0]!.state = 'playing';
          } else if (operation === 'updateLiveScore') {
            liveScores.push(input);
            Object.assign(match, {
              liveScore1: 0,
              liveScore2: 0,
              score1: 0,
              score2: 0,
              progressRevision: initialProgress + 1,
            });
          } else {
            results.push(input);
            Object.assign(match, {
              status: 'complete',
              outcome: 'played',
              winnerId: match.player1Id,
              score1: 2,
              score2: 1,
              liveScore1: null,
              liveScore2: null,
              revision: initialRevision + 1,
            });
            desk.queue = [];
            desk.active = 0;
          }
          const response = { result: { data: { status: 'approved' } } };
          await route.fulfill({ json: batch ? [response] : response });
        });
      }

      await page.goto(`/operate/${PLAN_ID}`);
      const active = page.locator(`article[data-match-id="${match.id}"]`);
      const card = page.locator('article.ops-match:visible').filter({ hasText: alias });
      const begin = active.getByRole('button', { name: 'Mark playing' });
      await expect(active.getByRole('button', { name: 'Return untaken call' })).toBeEnabled();
      const playersTab = page.getByRole('tab', { name: 'Players', exact: true });
      const finder = page.getByRole('region', { name: 'Find a player', exact: true });
      const current = finder.locator('.to-player-call');
      const row = finder.locator('.to-player-matches li').filter({
        has: page.getByText(match.label, { exact: true }),
      });
      const openCurrent = async () => {
        await current.getByRole('button', { name: 'Open current match' }).press('Enter');
        await expect(page.locator('#match-desk')).toBeFocused();
      };
      await playersTab.press('Enter');
      await finder.getByLabel('Player name', { exact: true }).fill(alias);
      const result = finder.getByRole('button', { name: new RegExp(alias) });
      await expect(result).toContainText(' · Called');
      await page.keyboard.press('Tab');
      await expect(result).toBeFocused();
      await result.press('Enter');
      await expect(current).toContainText('Called · Window setup');
      await expect(current).toContainText(`${alias} vs ${match.player2Name}`);
      await finder
        .getByRole('button', { name: /^Remaining matches and waiting reasons/ })
        .press('Enter');
      await expect(row).toContainText('Called · waiting to start');
      await capture(page, testInfo.outputPath('finder-called.png'));
      expect(
        (
          await new AxeBuilder({ page })
            .include('.ops-page')
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      await openCurrent();
      await expect(card.getByText('Called', { exact: true })).toBeVisible();
      await expect(card.getByText('Waiting for play to start')).toBeVisible();
      await expect(card.getByText(/Live game score/)).toHaveCount(0);
      await expect(card.getByRole('button', { name: 'Finish match' })).toBeEnabled();
      expect(commands).toEqual([]);
      await capture(page, testInfo.outputPath('called.png'));
      expect(
        (
          await new AxeBuilder({ page })
            .include('.ops-page')
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);

      await begin.press('Enter');
      await expect(card.getByText('Playing now', { exact: true })).toBeVisible();
      await expect(card.getByText('Match in progress', { exact: true })).toBeVisible();
      await expect(card.getByText(/Live game score/)).toHaveCount(0);
      expect(commands).toEqual([
        {
          kind: 'beginPlay',
          matchId: match.id,
          expectedRevision: initialRevision,
          expectedResourceRevision: 12,
        },
      ]);
      await capture(page, testInfo.outputPath('started.png'));
      await playersTab.press('Enter');
      await expect(current).toContainText('Playing · Window setup');
      await expect(current).toContainText(`${alias} vs ${match.player2Name}`);
      await expect(row).toContainText('Playing now');
      await capture(page, testInfo.outputPath('finder-started.png'));
      await openCurrent();

      await card.getByRole('button', { name: 'Update live score' }).press('Enter');
      await card.getByRole('button', { name: 'Save live score' }).press('Enter');
      await expect(card.getByText('Live game score · match still in progress')).toBeVisible();
      await expect(card.locator('.ops-contestant b')).toHaveText(['0', '0']);
      expect(liveScores).toEqual([
        {
          matchId: match.id,
          expectedRevision: initialRevision,
          expectedProgressRevision: initialProgress,
          score1: 0,
          score2: 0,
        },
      ]);
      await capture(page, testInfo.outputPath('provisional.png'));
      await playersTab.press('Enter');
      await expect(current).toContainText(`${alias} 0 – 0 ${match.player2Name}`);
      await capture(page, testInfo.outputPath('finder-provisional.png'));
      await openCurrent();

      await card.getByRole('button', { name: 'Finish match' }).press('Enter');
      await card.getByRole('spinbutton').first().fill('2');
      await card.getByRole('spinbutton').last().fill('1');
      await card.getByRole('button', { name: 'Confirm result' }).press('Enter');
      await expect(card.getByText('Final result', { exact: true })).toBeVisible();
      await expect(
        card.getByText(/Live game score|Waiting for play to start|Match in progress/),
      ).toHaveCount(0);
      await expect(card.locator('.ops-contestant b')).toHaveText(['2', '1']);
      expect(results).toEqual([
        expect.objectContaining({
          matchId: match.id,
          expectedRevision: initialRevision,
          requestId: expect.any(String),
          outcome: 'played',
          score1: 2,
          score2: 1,
        }),
      ]);
      await capture(page, testInfo.outputPath('recorded.png'));
      await playersTab.press('Enter');
      await expect(finder.getByRole('button', { name: 'Open current match' })).toHaveCount(0);
      expect(unexpected).toEqual([]);
    });

test('native station details respect the started fact independently of the shared call flag', async ({
  page,
}) => {
  const { overview, unexpected } = await mockEvent(page, { role: 'admin' });
  const match = overview.matches.find((row) => row.status === 'playing')!;
  Object.assign(match, { started: false, called: false });
  await page.goto(`/operate/${PLAN_ID}`);
  const card = page.locator('article.ops-match:visible').filter({ hasText: match.label });
  await expect(card.getByText('Called', { exact: true })).toBeVisible();
  await expect(card.getByText('Waiting for play to start')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Return to queue' })).toBeEnabled();
  await page.getByRole('tab', { name: 'Players', exact: true }).press('Enter');
  const finder = page.getByRole('region', { name: 'Find a player', exact: true });
  const playerName = overview.entrants.find(({ id }) => id === match.player1Id)!.name;
  await finder.getByLabel('Player name').fill(playerName);
  await finder
    .locator('.to-player-result')
    .filter({ has: page.getByText(playerName, { exact: true }) })
    .press('Enter');
  const station = overview.stations.find(({ id }) => id === match.stationId)!;
  await expect(finder.locator('.to-player-call')).toContainText(`Called · ${station.name}`);
  expect(unexpected).toEqual([]);
});

test('Broadcast details distinguish a named station call from started play', async ({
  page,
}, testInfo) => {
  const { overview, unexpected } = await mockEvent(page, { role: 'admin' });
  const match = overview.matches.find((row) => row.status === 'playing')!;
  const station = overview.stations.find((row) => row.id === match.stationId)!;
  Object.assign(station, { currentMatchId: match.id });
  Object.assign(match, { started: false, called: true });
  Object.assign(overview, { sharedDispatch: { active: 0, capacity: 2, overCapacity: 0 } });
  await page.goto(`/operate/${PLAN_ID}?view=broadcast&station=${station.id}`);
  const card = page.locator('.ops-main-stage article.ops-match');
  await expect(card.getByText('Called', { exact: true })).toBeVisible();
  await expect(card.getByText('Waiting for play to start')).toBeVisible();
  await expect(card.getByText(/Live game score/)).toHaveCount(0);
  await capture(page, testInfo.outputPath('broadcast-called.png'));

  Object.assign(match, { started: true, called: false });
  await page.reload();
  await expect(card.getByText('Playing now', { exact: true })).toBeVisible();
  await expect(card.getByText('Match in progress', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Update live score' })).toBeEnabled();
  await capture(page, testInfo.outputPath('broadcast-started.png'));
  expect(unexpected).toEqual([]);
});

for (const native of [true, false]) {
  test(`closed finder describes the last ${native ? 'native call' : 'linked assignment'} from recorded facts`, async ({
    page,
  }) => {
    const { overview, responses, unexpected } = await mockEvent(page, { role: 'admin' });
    Object.assign(overview.plan, {
      status: 'cancelled',
      bracketMode: native ? 'native' : 'challonge',
      liveOwned: native,
    });
    responses['eventOps.delivery.status'] = { configured: false };
    const match = overview.matches.find((row) => row.status === 'playing')!;
    Object.assign(match, {
      called: native || undefined,
      started: native ? false : undefined,
      score1: native ? null : 0,
      score2: native ? null : 2,
      liveScore1: null,
      liveScore2: null,
    });
    const station = overview.stations.find(({ id }) => id === match.stationId)!;
    await page.goto(`/operate/${PLAN_ID}?view=players`);
    const finder = page.getByRole('region', { name: 'Find a player', exact: true });
    const state = native ? 'Last recorded call' : 'Last recorded as playing';
    const playerName = overview.entrants.find(({ id }) => id === match.player1Id)!.name;
    await finder.getByLabel('Player name').fill(playerName);
    const result = finder
      .locator('.to-player-result')
      .filter({ has: page.getByText(playerName, { exact: true }) });
    await expect(result).toContainText(state);
    await result.press('Enter');
    await expect(finder).toContainText('Event closed · these are the last recorded assignments.');
    const current = finder.locator('.to-player-call');
    await expect(current).toContainText(`${state} · ${station.name}`);
    await expect(current).toContainText(
      `${match.player1Name} ${native ? 'vs' : '0 – 2'} ${match.player2Name}`,
    );
    await finder
      .getByRole('button', { name: /^Remaining matches and waiting reasons/ })
      .press('Enter');
    await expect(finder.locator('.to-player-matches')).toContainText(state);
    await expect(finder.getByRole('button', { name: 'Open next match' })).toHaveCount(0);
    expect(unexpected).toEqual([]);
  });
}
