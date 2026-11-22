import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { Desk } from '../src/pages/admin/dispatchTypes';
import { mockEvent, PLAN_ID, ready } from './fixtures';

const title = 'Tech In Place · Greater Western Sydney November Championship';
const alias = 'Alexandria with a long tournament alias from Western Sydney';

async function inspect(page: Page, testInfo: TestInfo, state: string, width: number) {
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
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
  await page.screenshot({
    path: testInfo.outputPath(`${state}.png`),
    fullPage: state === 'expanded-attention',
    animations: 'disabled',
  });
}

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440]) {
    test(`TO attention shows one clear status or the actual decisions in ${theme} at ${width}px`, async ({
      page,
      context,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const { overview, responses, unexpected } = await mockEvent(page, { role: 'player' });
      overview.plan.name = title;
      overview.stationQueues = [];
      const playing = overview.matches.find((match) => match.status === 'playing')!;
      const readyMatch = overview.matches.find(
        (match) => match.status === 'ready' && match.division === 'upper',
      )!;
      const capacity = { active: 0, capacity: 2, overCapacity: 0 };
      const desk: Desk = {
        ...capacity,
        mode: 'shared',
        resourceRevision: overview.settings.resourceRevision,
        queueRevision: 0,
        stations: overview.stations.map((station) => ({
          ...station,
          enabled: true,
          reserved: station.currentMatchId === playing.id,
          revision: 0,
        })),
        entrants: [],
        pools: [],
        queue: [playing, readyMatch].map((match) => ({
          matchId: match.id,
          state: match.id === playing.id ? 'playing' : 'ready',
          waitingSince: 0,
          downstream: 0,
          reason: match.id === playing.id ? 'Playing' : 'Waiting time, then draw order',
          canStart: match.id === readyMatch.id,
          canDispatchOrdinary: match.id === readyMatch.id,
          eligibleStationIds: match.availability.eligibleStationIds,
          reasons: [],
        })),
      };
      Object.assign(overview, { sharedDispatch: capacity, operatorDispatch: desk });
      responses['eventOps.delivery.status'] = { configured: false };
      const alreadyReviewed = overview.reports;
      const route = `/operate/${PLAN_ID}`;
      const attention = page.getByRole('region', { name: 'Needs attention' });
      const empty = attention.getByText('No decisions pending.', { exact: true });
      const interruption = page.getByRole('alert').filter({ hasText: 'Live updates interrupted.' });

      await page.goto(route);
      await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
      await expect(attention).toHaveText('No decisions pending.');
      await expect(empty).toBeVisible();
      await expect(attention.getByRole('status')).toHaveCount(0);
      await expect(page.getByText('TO desk', { exact: true })).toBeVisible();
      await inspect(page, testInfo, 'empty-attention', width);

      await context.setOffline(true);
      await expect(interruption).toContainText('Last loaded data is shown.');
      await expect(empty).toHaveCount(0);
      if (width === 390) await inspect(page, testInfo, 'interrupted-attention', width);
      await context.setOffline(false);
      await expect(interruption).toHaveCount(0);
      await expect(empty).toBeVisible();

      // Reverse the Roy–Meta K result to create a three-way tie in Lower Pool A.
      const tiebreak = overview.matches.find(
        (match) => match.player1Name === 'Roy' && match.player2Name === 'Meta K',
      )!;
      Object.assign(tiebreak, { score1: 0, score2: 2, winnerId: tiebreak.player2Id });

      // Keep the report and organiser hold in a different pool from the ruling.
      const [recorded, held] = overview.matches.filter(
        (match) => match.status === 'ready' && match.division === 'lower' && match.poolIndex === 1,
      );
      Object.assign(recorded!, {
        status: 'complete',
        player1Name: alias,
        started: true,
        score1: 2,
        score2: 0,
        winnerId: recorded!.player1Id,
        outcome: 'played',
        revision: 1,
      });
      Object.assign(held!, { status: 'blocked', blockedReason: 'Organiser hold' });
      overview.reports = [
        {
          ...alreadyReviewed[0]!,
          id: 'fixture-disagreement',
          matchId: recorded!.id,
          submittedRevision: recorded!.revision,
          expectedRevision: recorded!.revision,
          status: 'pending',
          isDispute: true,
          score1: 1,
          score2: 2,
          winnerId: recorded!.player2Id!,
        },
        {
          ...alreadyReviewed[1]!,
          id: 'fixture-approval',
          matchId: playing.id,
          submittedRevision: playing.revision,
          expectedRevision: playing.revision,
          status: 'pending',
          isDispute: false,
          winnerId: playing.player1Id!,
        },
      ];
      Object.assign(overview, {
        poolOrders: [
          {
            poolId: 'lower-a',
            division: 'lower',
            poolIndex: 0,
            status: 'manual_required',
            reason: 'Confirm a ruling for the tied places.',
            plannerConfirmation: { available: true },
          },
        ],
      });
      await page.reload();
      await expect(attention.getByRole('heading', { name: 'Needs attention 4' })).toBeVisible();
      await expect(attention.getByText('No decisions pending.', { exact: true })).toHaveCount(0);
      await expect(attention.getByText('Review pending decisions below.')).toHaveCount(0);
      const shortcut = attention.getByRole('button', { name: 'Review disagreements' });
      const scores = attention.getByRole('button', { name: 'Score reviews · 2' });
      const pools = attention.getByRole('button', { name: 'Pool orders · 1' });
      const matches = attention.getByRole('button', { name: 'Match decisions · 1' });
      await expect(attention.getByRole('button')).toHaveText([
        'Review disagreements',
        /Score reviews · 2/,
        /Pool orders · 1/,
        /Match decisions · 1/,
      ]);
      await inspect(page, testInfo, 'busy-attention', width);

      await shortcut.focus();
      await page.keyboard.press('Tab');
      await expect(scores).toBeFocused();
      await page.keyboard.press('Space');
      await expect(attention.getByText(new RegExp(alias))).toBeVisible();
      await expect(attention.getByText(/Awaiting TO approval/)).toBeVisible();
      await pools.press('Enter');
      await matches.press('Enter');
      await expect(
        attention.getByRole('button', { name: /Review pool order for lower · Pool A/ }),
      ).toBeVisible();
      await expect(attention.getByText(/Organiser hold/)).toBeVisible();
      await inspect(page, testInfo, 'expanded-attention', width);
      await shortcut.press('Enter');
      const dispute = page.locator('#score-report-fixture-disagreement');
      await expect(dispute).toBeFocused();
      await expect(dispute).toContainText(`Recorded result · ${alias} 2–0`);
      await expect(dispute).toContainText(`Submitted result · ${alias} 1 – 2`);

      // An interruption retains actionable facts from the last loaded overview.
      await context.setOffline(true);
      await expect(interruption).toBeVisible();
      await expect(attention.getByRole('heading', { name: 'Needs attention 4' })).toBeVisible();
      await context.setOffline(false);
      await expect(interruption).toHaveCount(0);
      expect(unexpected).toEqual([]);
    });
  }

test('capacity setup stays actionable and distinct from an interruption', async ({
  page,
  context,
}) => {
  const { overview, unexpected } = await mockEvent(page, { role: 'player' });
  overview.stations = [];
  overview.stationQueues = [];
  const active = overview.matches.find((match) => match.status === 'playing')!;
  Object.assign(active, { status: 'ready', stationId: null });

  await page.goto(`/operate/${PLAN_ID}`);
  const attention = page.getByRole('region', { name: /^Needs attention/ });
  const setup = attention.getByRole('button', { name: 'Set up stations', exact: true });
  await expect(attention.getByRole('heading')).toHaveText('Needs attention 1');
  await expect(attention.getByText('No stations configured', { exact: true })).toBeVisible();
  await expect(attention.getByText('Review pending decisions below.')).toHaveCount(0);
  await expect(attention.getByText('No decisions pending.')).toHaveCount(0);
  await setup.press('Enter');
  await expect(page.locator('#station-controls')).toBeFocused();

  await context.setOffline(true);
  await expect(
    page.getByRole('alert').filter({ hasText: 'Live updates interrupted.' }),
  ).toBeVisible();
  await expect(setup).toBeVisible();
  expect(unexpected).toEqual([]);
});
