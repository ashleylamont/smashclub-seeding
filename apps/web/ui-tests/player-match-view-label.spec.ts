import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { chooseOption } from '../test-support/controls';
import { mockEvent, PLAN_ID, ready } from './fixtures';

for (const theme of ['dark', 'light'] as const) {
  for (const width of [390, 1440]) {
    test(`${theme} ${width}px match view describes which results it shows`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const fixture = await mockEvent(page, { role: 'player' });
      const reviewed = fixture.snapshot.matches.find(
        (match) => match.status === 'complete' && match.division === 'lower',
      )!;
      const selfRun = fixture.snapshot.matches.find(
        (match) => match.status === 'playing' && match.division === 'upper',
      )!;
      Object.assign(reviewed, {
        outcome: 'played',
        score1: 2,
        score2: 0,
        winnerId: reviewed.player1Id,
      });
      Object.assign(selfRun, {
        status: 'complete',
        outcome: 'played',
        score1: 2,
        score2: 1,
        winnerId: selfRun.player1Id,
        player2Name: 'Chrom with an exceptionally long tournament alias',
      });
      Object.assign(fixture.snapshot, {
        poolSchedules: [
          {
            division: selfRun.division,
            poolIndex: selfRun.poolIndex,
            active: true,
            stationIds: fixture.snapshot.stations.map(({ id }) => id),
            selfRun: true,
            autoAcceptScores: true,
          },
        ],
      });

      await page.goto(`/play/${PLAN_ID}`);
      const matches = page.locator('#my-matches');
      const view = matches.getByRole('combobox', { name: 'Match view' });
      const openMatches = page.getByRole('option', {
        name: 'Open matches & some results',
        exact: true,
      });
      const recordedResults = page.getByRole('option', { name: 'Recorded results', exact: true });
      const cards = matches.locator('article.ops-match');
      const reviewedCard = cards.filter({ hasText: reviewed.label });
      const selfRunCard = cards.filter({ hasText: selfRun.label });
      await chooseOption(view, 'results');
      await expect(reviewedCard).toContainText('Confirmed result: 2 – 0');
      await expect(selfRunCard).toContainText('Confirmed result: 2 – 1');

      await view.press('Enter');
      await expect(recordedResults).toBeFocused();
      await page.keyboard.press('ArrowUp');
      await expect(openMatches).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(view).toBeFocused();
      await expect(view).toHaveAttribute('data-value', 'matches');
      await expect(reviewedCard).toHaveCount(0);
      await expect(selfRunCard).toContainText('Confirmed result: 2 – 1');
      await expect(view).toContainText('Open matches & some results');

      await ready(page);
      await view.scrollIntoViewIfNeeded();
      await view.press('Enter');
      await expect(openMatches).toBeFocused();
      await page.screenshot({ path: testInfo.outputPath('match-view-menu.png') });
      await page.keyboard.press('ArrowDown');
      await expect(recordedResults).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(view).toBeFocused();
      await expect(view).toContainText('Recorded results');
      await expect(reviewedCard).toContainText('Confirmed result: 2 – 0');
      await reviewedCard.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath('recorded-results.png') });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(
        (
          await new AxeBuilder({ page })
            .include('#my-matches')
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      expect(fixture.starts).toEqual([]);
      expect(fixture.submissions).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
  }
}
