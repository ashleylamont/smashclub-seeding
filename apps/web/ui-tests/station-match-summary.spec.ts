import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mockEvent, PLAN_ID, ready } from './fixtures';

async function capture(page: Page, selector: string, path: string) {
  // Use the same settled page position for contrast analysis and the capture.
  await page.evaluate(() => scrollTo(0, 0));
  await ready(page);
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    (
      await new AxeBuilder({ page })
        .include(selector)
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.screenshot({ path, fullPage: true });
}

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test(`${theme} ${width}px stations and pool rounds show the actual match state`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const { overview, snapshot, unexpected } = await mockEvent(page, { role: 'admin' });
      const match = snapshot.matches.find((item) => item.status === 'playing')!;
      const station = snapshot.stations.find(({ id }) => id === match.stationId)!;
      const alias = 'Alexandria with a long tournament alias from Western Sydney';
      const entrant = snapshot.entrants.find(({ id }) => id === match.player1Id)!;
      entrant.name = alias;
      for (const row of snapshot.matches) {
        if (row.player1Id === entrant.id) row.player1Name = alias;
        if (row.player2Id === entrant.id) row.player2Name = alias;
      }
      Object.assign(match, { started: true, called: false });
      await page.goto(`/operate/${PLAN_ID}`);
      const run = page.getByRole('tabpanel', { name: 'Run matches' });
      const tile = run.locator('.ops-station-tile').filter({ hasText: station.name });
      const stationScore = tile.locator('b');
      await expect(tile).toHaveClass(/is-playing/);
      await expect(tile.getByText('Playing now', { exact: true })).toBeVisible();
      await expect(tile).toContainText(alias);
      await expect(stationScore).toHaveText('vs');
      const openScore = tile.getByRole('button', { name: 'Score match', exact: true });
      await openScore.press('Enter');
      await expect(run.locator('#match-desk')).toBeFocused();
      await expect(run.getByRole('button', { name: 'Update live score' })).toBeEnabled();
      await capture(page, '.ops-page', testInfo.outputPath('to-station-unscored.png'));

      const playerUrl = `/play/${PLAN_ID}?player=${match.player1Id}#what-next`;
      await page.goto(playerUrl);
      const next = page.getByRole('region', { name: 'What next' });
      const playerStation = next
        .getByRole('article')
        .filter({ has: page.getByRole('heading', { name: station.name, exact: true }) });
      const playerScore = playerStation.locator('.pool-flow-current > b');
      await expect(playerStation.getByText('Playing now', { exact: true })).toBeVisible();
      await expect(playerScore).toHaveText('vs');
      await expect(playerStation.getByRole('button', { name: 'Report this result' })).toBeEnabled();
      await capture(page, '.player-event-hub', testInfo.outputPath('player-station-unscored.png'));

      Object.assign(match, { score1: 0, score2: 0, liveScore1: 0, liveScore2: 0 });
      await page.reload();
      await expect(playerScore).toHaveText('0 – 0');
      await page.goto(`/operate/${PLAN_ID}`);
      await expect(stationScore).toHaveText('0–0');

      Object.assign(match, {
        started: false,
        called: true,
        score1: null,
        score2: null,
        liveScore1: null,
        liveScore2: null,
      });
      const shared = { active: 0, capacity: 1, overCapacity: 0 };
      Object.assign(snapshot, { sharedDispatch: shared, stationQueues: [] });
      Object.assign(overview, { sharedDispatch: shared, stationQueues: [] });
      await page.goto(playerUrl);
      const calls = next.getByRole('region', { name: 'Match calls' });
      const rounds = next.locator('.pool-flow-rounds');
      const disclosure = rounds.getByRole('button', { name: /Upper Pool A.*rounds/i });
      const roundRow = rounds.getByRole('listitem').filter({ hasText: alias }).filter({
        hasText: match.player2Name!,
      });
      await expect(calls.getByText(`Called · ${station.name}`, { exact: true })).toBeVisible();
      await disclosure.press('Enter');
      await expect(disclosure).toBeFocused();
      await expect(roundRow.getByText('Called', { exact: true })).toBeVisible();
      await expect(roundRow.getByText('Playing now', { exact: true })).toHaveCount(0);
      await capture(page, '.player-event-hub', testInfo.outputPath('player-round-called.png'));

      Object.assign(match, { called: false, started: true });
      await page.reload();
      await disclosure.press('Enter');
      await expect(roundRow.getByText('Playing now', { exact: true })).toBeVisible();
      Object.assign(match, {
        status: 'complete',
        outcome: 'played',
        winnerId: match.player1Id,
        score1: 2,
        score2: 1,
      });
      await page.reload();
      await disclosure.press('Enter');
      await expect(roundRow.getByText('2–1 · complete', { exact: true })).toBeVisible();
      expect(unexpected).toEqual([]);
    });
