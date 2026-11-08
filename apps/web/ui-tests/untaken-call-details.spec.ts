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
        label: 'Pool A · Round 1',
        player1Name: alias,
        status: 'playing',
        started: false,
        called: true,
        stationId: null,
        score1: null,
        score2: null,
        liveScore1: null,
        liveScore2: null,
        resourceRevision: 12,
      });
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
      await active.getByRole('button', { name: 'Score / details' }).press('Enter');
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
