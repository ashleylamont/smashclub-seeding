import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { EventPlanView } from '../src/lib/apiTypes';
import { chooseOption } from '../test-support/controls';
import { bracketCaptureOptions, mockEvent, PLAN_ID, ready } from './fixtures';

async function planner(page: Page) {
  const fixture = await mockEvent(page, { role: 'admin' });
  const view: EventPlanView = {
    plan: {
      id: PLAN_ID,
      name: 'Nemesis · Doubles planning',
      eventDate: '2026-10-05T08:00:00Z',
      slugPrefix: null,
      status: 'draft',
      softLockedAt: null,
      softLockedBy: null,
      bracketMode: 'native',
      competitionFormat: 'doubles',
      structure: 'round_robin',
      structureOptions: { roundRobinMeetings: 1 },
      usePairRatings: true,
      nativeSeedContext: null,
      historicalAdoption: null,
      upperTargetSize: null,
      poolSize: 4,
      rankingSnapshotAt: null,
      createdAt: '2026-10-04T00:00:00Z',
    },
    entries: [
      {
        name: 'Alex with a long tournament alias / Bea with a very long partner alias',
        mean: 1600,
        sd: 200,
        history: 0,
        adjustment: 0,
      },
      { name: 'Charlie / Drew', mean: 1500, sd: 50, history: 6, adjustment: 12 },
      { name: 'Ellis / Flynn', mean: 1700, sd: 170, history: 0, adjustment: 0 },
    ].map((pair, i) => ({
      id: `pair-${i}`,
      sourceLineNumber: i + 1,
      rawInput: '',
      cleanedName: pair.name,
      companyCode: null,
      playerId: `pair-${i}`,
      playerName: pair.name,
      publicName: pair.name,
      playerStatus: 'active',
      resolutionMethod: 'manual',
      divisionPreference: 'auto',
      assignedDivision: null,
      snapshotRank: null,
      snapshotScore: null,
      snapshotMean: null,
      snapshotSd: null,
      divisionSeed: null,
      currentRank: null,
      currentScore: pair.mean - 2 * pair.sd,
      currentMean: pair.mean,
      currentSd: pair.sd,
      lastPlayedDate: null,
      candidates: [],
      pairRating: {
        enabled: true,
        baselineMean: pair.mean - pair.adjustment,
        baselineSd: Math.sqrt(pair.sd ** 2 - 43 ** 2),
        adjustment: pair.adjustment,
        adjustmentSd: 43,
        playedSets: pair.history,
        eventDays: pair.history ? 2 : 0,
      },
    })),
    divisions: [
      { division: 'upper', size: 3, poolCount: 0, pools: [], consolation: null, championship: [] },
    ],
    brackets: [],
    issues: { blocking: [], warnings: [] },
  };
  Object.assign(fixture.responses, {
    'admin.eventPlanner.plan': view,
    'admin.eventPlanner.projectTournament': { formats: [] },
  });
  return { ...fixture, view };
}

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test(`pair evidence and view-only rating sort fit ${theme} ${width}px`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const fixture = await planner(page);
      const writes: string[] = [];
      page.on('request', (request) => {
        if (request.method() === 'POST') writes.push(request.url());
      });
      await page.goto(`/admin/event-planner?plan=${PLAN_ID}&step=roster`);
      const roster = page.locator('section').filter({
        has: page.getByRole('heading', { name: 'Doubles roster · 3 teams / 6 players' }),
      });
      const rows = roster.getByRole('row').filter({ has: page.getByRole('cell') });
      await expect(rows).toHaveCount(3);
      await expect(roster).toContainText('added pair uncertainty can lower their seeding score');
      await expect(rows.nth(0)).toContainText('No prior pair results');
      await expect(rows.nth(0)).toContainText('Mean adjustment +0 · pair SD 43');
      await expect(rows.nth(1)).toContainText('6 prior played sets · 2 nights');
      await roster.getByRole('combobox', { name: 'Sort pairs' }).focus();
      await page.keyboard.press('Enter');
      await page.getByRole('option', { name: 'Skill: highest first', exact: true }).press('Enter');
      await expect(rows.nth(0)).toContainText('Ellis / Flynn');
      await chooseOption(roster.getByRole('combobox', { name: 'Sort pairs' }), 'seed_desc');
      await expect(rows.nth(0)).toContainText('Charlie / Drew');
      await chooseOption(roster.getByRole('combobox', { name: 'Sort pairs' }), 'skill_asc');
      await expect(rows.nth(0)).toContainText('Charlie / Drew');
      await chooseOption(roster.getByRole('combobox', { name: 'Sort pairs' }), 'roster');
      await expect(rows.nth(0)).toContainText('Alex with a long tournament alias');
      expect(fixture.view.entries.map((e) => [e.id, e.snapshotScore, e.divisionSeed])).toEqual([
        ['pair-0', null, null],
        ['pair-1', null, null],
        ['pair-2', null, null],
      ]);
      expect(writes).toEqual([]);
      const region = roster.getByRole('region', { name: 'Pair ratings', exact: true });
      if (width === 390) {
        await region.focus();
        await page.keyboard.press('ArrowRight');
        await expect
          .poll(() => region.evaluate((element) => element.scrollLeft))
          .toBeGreaterThan(0);
        await region.evaluate((element) => {
          element.scrollLeft = 0;
        });
      }
      await ready(page);
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
          .violations,
      ).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.mouse.move(0, 0);
      await page.screenshot({
        ...bracketCaptureOptions,
        path: testInfo.outputPath(`pair-planner-${theme}-${width}.png`),
        fullPage: true,
      });
      await expect(page).toHaveScreenshot(`pair-planner-${theme}-${width}.png`, {
        ...bracketCaptureOptions,
        fullPage: true,
      });
      expect(fixture.unexpected).toEqual([]);
    });

test('frozen roster sorts the displayed snapshots and marks old missing breakdowns honestly', async ({
  page,
}) => {
  const fixture = await planner(page);
  fixture.view.plan.status = 'roster_frozen';
  fixture.view.entries.forEach((entry, i) => {
    entry.snapshotMean = [1550, 1800, 1600][i]!;
    entry.snapshotSd = 80;
    entry.snapshotScore = entry.snapshotMean - 160;
    entry.divisionSeed = i + 1;
  });
  fixture.view.entries[0]!.pairRating = undefined;
  await page.goto(`/admin/event-planner?plan=${PLAN_ID}&step=roster`);
  const ratings = page.getByRole('region', { name: 'Pair ratings', exact: true });
  const rows = ratings.getByRole('row').filter({ has: page.getByRole('cell') });
  await expect(ratings).toContainText('Breakdown unavailable for this frozen roster.');
  await expect(
    page.getByRole('checkbox', { name: 'Include experimental WHR pair adjustments in seeds' }),
  ).toHaveCount(0);
  await chooseOption(page.getByRole('combobox', { name: 'Sort pairs' }), 'skill_desc');
  await expect(rows.nth(0)).toContainText('Charlie / Drew');
  await expect(rows.nth(0)).toContainText('1800 ± 80');
  expect(fixture.unexpected).toEqual([]);
});
