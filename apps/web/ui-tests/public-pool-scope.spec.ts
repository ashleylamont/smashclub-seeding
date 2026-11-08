import { readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { bracketCaptureOptions, mockEvent, PLAN_ID, ready, type FixtureOptions } from './fixtures';

const captureStyle = readFileSync(bracketCaptureOptions.stylePath, 'utf8');

for (const theme of ['dark', 'light'] as const)
  for (const { width, structure, poolIndex, title, heading } of [
    {
      width: 390,
      structure: 'round_robin',
      poolIndex: 0,
      title: 'Open round robin',
      heading: 'Open round robin',
    },
    {
      width: 1440,
      structure: 'pools_finals',
      poolIndex: 26,
      title: 'Open Pool AA',
      heading: 'Open · Pool AA',
    },
  ] as const)
    test(`${theme} ${structure} displays the actual pool at ${width}px`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const { poolKey, sample, alias, unexpected } = await openPool(page, structure, poolIndex);
      const params = new URLSearchParams({ pool: poolKey });
      await page.goto(`/play/${PLAN_ID}?${params}`);
      const poolFilter = page.getByRole('combobox', { name: 'Your pool' });
      await expect(poolFilter).toHaveAttribute('data-value', poolKey);
      await expect(poolFilter).toContainText(title);
      const schedule = page.getByRole('button', {
        name: `${title} ${sample.rounds.length} rounds`,
      });
      await schedule.press('Enter');
      await expect(schedule).toBeFocused();
      const share = page.getByRole('link', { name: 'Open this pool →' });
      await expect(share).toHaveAttribute('href', `/play/${PLAN_ID}?${params}#event-pools`);
      const progress = page.getByRole('region', { name: 'Pools' });
      await expect(progress.getByRole('heading', { name: heading, exact: true })).toBeVisible();
      await expect(progress.getByRole('progressbar', { name: `${title} progress` })).toBeVisible();
      await expect(progress.getByText(alias, { exact: true })).toBeVisible();
      const results = page.getByRole('region', { name: 'Results', exact: true });
      await expect(results.getByText(heading, { exact: true })).toBeVisible();
      await expect(results.getByText('Final result', { exact: true })).toBeVisible();
      await expect(results.getByText(`Open pool ${poolIndex + 1}`, { exact: true })).toHaveCount(0);
      await ready(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
          .violations,
      ).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath('public-pool-scope.png'),
        fullPage: true,
        style: captureStyle,
      });
      expect(unexpected).toEqual([]);
    });

test('open pool result cards retain meaningful match identifiers', async ({ page }) => {
  const { snapshot, unexpected } = await openPool(page, 'pools_finals', 26);
  snapshot.matches[0]!.label = 'Open pool tiebreak set';
  await page.goto(`/play/${PLAN_ID}?pool=upper%3A26`);
  const results = page.getByRole('region', { name: 'Results', exact: true });
  await expect(results.getByText('Open · Pool AA', { exact: true })).toBeVisible();
  await expect(results.getByText('Open pool tiebreak set', { exact: true })).toBeVisible();
  expect(unexpected).toEqual([]);
});

test('OBS progress uses the open pool title and keeps its recorded set count', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const { unexpected, alias } = await openPool(page, 'pools_finals', 26);
  await page.goto(`/overlay/${PLAN_ID}?presentation=progress&controls=0`);
  const progress = page.getByRole('region', { name: 'Tournament progress', exact: true });
  await expect(
    progress.getByRole('heading', { name: 'Open · Pool AA', exact: true }),
  ).toBeVisible();
  await expect(progress.getByRole('cell', { name: alias, exact: true })).toBeVisible();
  await expect(progress).toContainText('1 / 6 sets complete');
  await ready(page);
  await page.screenshot({ path: testInfo.outputPath('open-pool-progress.png') });
  expect(unexpected).toEqual([]);
});

test('TO finder uses the same open pool name and keeps the actual pool key', async ({
  page,
}, testInfo) => {
  const { unexpected } = await openPool(page, 'pools_finals', 26, { role: 'admin' });
  await page.goto(`/operate/${PLAN_ID}?view=players`);
  const finder = page.getByRole('region', { name: 'Find a player' });
  await finder.getByRole('searchbox').fill('Pit');
  await finder.getByRole('button', { name: /Pit.*Open Pool AA/ }).press('Enter');
  await expect(finder.getByRole('button', { name: 'Open Pool AA', exact: true })).toBeVisible();
  await ready(page);
  await page.screenshot({
    path: testInfo.outputPath('organiser-pool-finder.png'),
    fullPage: true,
    style: captureStyle,
  });
  await finder.getByRole('button', { name: 'Open Pool AA', exact: true }).press('Enter');
  await expect(page.getByRole('tab', { name: 'Run matches', exact: true })).toHaveAttribute(
    'data-state',
    'active',
  );
  await expect(page.getByRole('combobox', { name: 'Pool', exact: true })).toHaveAttribute(
    'data-value',
    'upper:26',
  );
  await expect(page.getByRole('combobox', { name: 'Pool', exact: true })).toContainText(
    'Open Pool AA',
  );
  await page.getByRole('tab', { name: 'Standings / draw', exact: true }).press('Enter');
  await expect(page.getByRole('heading', { name: /Open · Pool AA 1\/6 sets/ })).toBeVisible();
  expect(unexpected).toEqual([]);
});

async function openPool(
  page: Page,
  structure: 'round_robin' | 'pools_finals',
  poolIndex: number,
  options?: FixtureOptions,
) {
  const fixture = await mockEvent(page, options);
  const { snapshot } = fixture;
  const poolKey = `upper:${poolIndex}`;
  Object.assign(snapshot.plan, { structure });
  const sample = snapshot.poolRounds.find((pool) => pool.poolKey === 'lower:1')!;
  const ids = new Set(sample.rounds.flatMap((round) => round.matchIds));
  snapshot.matches = snapshot.matches.filter((match) => ids.has(match.id));
  const alias = 'Alexandria with a long tournament alias from Western Sydney';
  const player = snapshot.matches[0]!.player1Id;
  for (const match of snapshot.matches) {
    Object.assign(match, { division: 'upper', poolIndex, label: `Open pool ${poolIndex + 1}` });
    if (match.player1Id === player) match.player1Name = alias;
    if (match.player2Id === player) match.player2Name = alias;
  }
  Object.assign(snapshot.matches[0]!, {
    status: 'complete',
    outcome: 'played',
    score1: 2,
    score2: 1,
    winnerId: player,
  });
  snapshot.poolRounds = [{ ...sample, poolKey }];
  snapshot.stationQueues = [];
  snapshot.placements = [];
  snapshot.prizes = [];
  Object.assign(fixture.overview, snapshot);
  return { ...fixture, poolKey, sample, alias };
}
