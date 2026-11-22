import { readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { darwinBaseline, darwinScreenshot } from './darwinScreenshot';
import { bracketCaptureOptions, mockEvent, PLAN_ID, ready } from './fixtures';

const captureStyle = readFileSync(bracketCaptureOptions.stylePath, 'utf8');
const alias = 'Alexandria with a long tournament alias from Western Sydney';
const url = `/play/${PLAN_ID}?pool=upper%3A0#what-next`;

async function openFixture(page: Page, theme: 'dark' | 'light', width: number) {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
  const { snapshot, unexpected } = await mockEvent(page);
  const pool = snapshot.poolRounds.find(({ poolKey }) => poolKey === 'upper:0')!;
  const matchFor = (id: string) => snapshot.matches.find((match) => match.id === id)!;
  const native = matchFor(pool.rounds[0]!.matchIds[0]!);
  const imported = matchFor(pool.rounds[2]!.matchIds[0]!);
  const played = matchFor(pool.rounds[1]!.matchIds[0]!);
  const upcoming = matchFor(pool.rounds[1]!.matchIds[1]!);
  const entrant = snapshot.entrants.find(({ id }) => id === native.player2Id)!;
  entrant.name = alias;
  for (const match of snapshot.matches) {
    if (match.player1Id === entrant.id) match.player1Name = alias;
    if (match.player2Id === entrant.id) match.player2Name = alias;
  }
  Object.assign(native, {
    status: 'complete',
    outcome: 'forfeit',
    winnerId: entrant.id,
    score1: null,
    score2: null,
  });
  Object.assign(imported, {
    status: 'complete',
    outcome: 'forfeit',
    winnerId: imported.player1Id,
    score1: 5,
    score2: 0,
  });
  Object.assign(played, {
    status: 'complete',
    outcome: 'played',
    winnerId: played.player1Id,
    score1: 5,
    score2: 0,
  });
  Object.assign(upcoming, {
    status: 'ready',
    outcome: null,
    winnerId: null,
    score1: null,
    score2: null,
  });

  await page.goto(url);
  const schedule = page.locator('.pool-flow-rounds');
  const disclosure = schedule.getByRole('button', { name: /Upper Pool A.*5 rounds/i });
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  await disclosure.press('Enter');
  await expect(disclosure).toBeFocused();
  const rowFor = (match: typeof played) =>
    schedule.getByRole('listitem').filter({
      hasText: `${match.player1Name} vs ${match.player2Name}`,
    });
  return {
    snapshot,
    unexpected,
    schedule,
    disclosure,
    native: rowFor(native),
    imported: rowFor(imported),
    importedWinner: imported.player1Name,
    played: rowFor(played),
    upcoming: rowFor(upcoming),
  };
}

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440]) {
    test(`${theme} ${width}px active pool schedule shows recorded forfeit winners`, async ({
      page,
    }) => {
      const fixture = await openFixture(page, theme, width);
      const { disclosure, schedule } = fixture;
      await expect(schedule.getByRole('heading', { name: /^Round \d+$/ })).toHaveCount(5);
      await expect(fixture.native.locator('small')).toHaveText(`Forfeit · ${alias} wins`);
      await expect(fixture.imported.locator('small')).toHaveText(
        `Forfeit · ${fixture.importedWinner} wins`,
      );
      await expect(fixture.played.locator('small')).toHaveText('5–0 · complete');
      await expect(fixture.upcoming.locator('small')).toHaveText('Upcoming');
      await expect(schedule.getByText(/^Resting:/)).toHaveCount(5);
      await expect(schedule.getByRole('button')).toHaveCount(1);

      await fixture.native.scrollIntoViewIfNeeded();
      await ready(page);
      await expect(fixture.native).toBeInViewport({ ratio: 1 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(
        (
          await new AxeBuilder({ page })
            .include('.player-event-hub')
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);

      fixture.snapshot.plan.status = 'complete';
      await page.reload();
      await page.getByRole('button', { name: 'Pool schedule history', exact: true }).press('Enter');
      await disclosure.press('Enter');
      await expect(fixture.native.locator('small')).toHaveText('Forfeit');
      await expect(fixture.imported.locator('small')).toHaveText('Forfeit');
      await expect(fixture.played.locator('small')).toHaveText('5–0 · complete');
      await expect(fixture.upcoming.locator('small')).toHaveText('No result recorded');
      expect(fixture.unexpected).toEqual([]);
    });

    test(
      `${theme} ${width}px expanded active pool schedule with forfeits`,
      darwinBaseline,
      async ({ page }, testInfo) => {
        const { schedule } = await openFixture(page, theme, width);
        await ready(page);
        await page.evaluate(() => scrollTo(0, 0));
        await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
        await page.screenshot({ path: testInfo.outputPath('player-hub.png'), fullPage: true });
        const name = `active-pool-forfeits-${theme}-${width}.png`;
        // A new reference has no comparison artifact with snapshot updates disabled.
        await schedule.screenshot({
          path: testInfo.outputPath(name),
          style: captureStyle,
          animations: 'disabled',
          scale: 'css',
        });
        await darwinScreenshot(schedule, name, bracketCaptureOptions);
      },
    );
  }
