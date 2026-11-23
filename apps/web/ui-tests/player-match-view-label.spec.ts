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

test.describe('focused match counts', () => {
  test.use({ hasTouch: true });

  for (const theme of ['dark', 'light'] as const) {
    for (const width of [390, 1440]) {
      test(`${theme} ${width}px focused results show the match count without call order`, async ({
        page,
      }, testInfo) => {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
        const fixture = await mockEvent(page, { role: 'player' });
        const current = fixture.snapshot.matches.find((match) => match.status === 'playing')!;
        const playerId = current.player1Id!;
        const recorded = fixture.snapshot.matches.findLast(
          (match) => match.player1Id === playerId && match.status === 'ready',
        )!;
        Object.assign(recorded, {
          status: 'complete',
          outcome: 'played',
          score1: 2,
          score2: 1,
          winnerId: playerId,
        });
        fixture.responses['me.claims'] = [
          { status: 'approved', playerId, playerName: current.player1Name },
        ];

        await page.goto(`/play/${PLAN_ID}`);
        const matches = page.locator('#my-matches');
        const player = matches.getByRole('combobox', { name: 'Show matches for' });
        const view = matches.getByRole('combobox', { name: 'Match view' });
        const summary = matches.locator('.player-matches-heading p');
        const cards = matches.getByRole('article');
        const draft = cards.first().getByRole('spinbutton').first();
        await expect(player).toHaveAttribute('data-value', playerId);
        await expect(cards.first()).toHaveAttribute('data-player-match-id', current.id);
        const originalOrder = await cards.evaluateAll((items) =>
          items.map((item) => item.getAttribute('data-player-match-id')),
        );
        await draft.fill('2');
        await matches.getByRole('button', { name: 'Match filters' }).press('Enter');

        const nextAndRecent = 'Selected player’s next & recent matches';
        const results = 'Recorded results';
        const selectView = async (from: string, to: string, key: 'ArrowUp' | 'ArrowDown') => {
          const option = page.getByRole('option', { name: to, exact: true });
          if (width === 390) {
            await view.tap();
            await option.tap();
          } else {
            await view.press('Enter');
            await expect(page.getByRole('option', { name: from, exact: true })).toBeFocused();
            await page.keyboard.press(key);
            await expect(option).toBeFocused();
            await page.keyboard.press('Enter');
            await expect(view).toBeFocused();
          }
          await expect(view).toContainText(to);
        };

        await selectView(nextAndRecent, results, 'ArrowUp');
        await expect(player).toHaveAttribute('data-value', playerId);
        await expect(cards).toHaveCount(1);
        await expect(cards.first()).toHaveAttribute('data-player-match-id', recorded.id);
        await expect(cards.first()).toContainText('Confirmed result: 2 – 1');
        await expect(summary).toHaveText('1 match in this view');
        await ready(page);
        await matches.locator('.pool-score-selection').screenshot({
          path: testInfo.outputPath('focused-recorded-results.png'),
        });

        await selectView(results, nextAndRecent, 'ArrowDown');
        await expect(player).toHaveAttribute('data-value', playerId);
        await expect(summary).toHaveText(`${originalOrder.length} matches in this view`);
        expect(
          await cards.evaluateAll((items) =>
            items.map((item) => item.getAttribute('data-player-match-id')),
          ),
        ).toEqual(originalOrder);
        await expect(draft).toHaveValue('2');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        expect(fixture.submissions).toEqual([]);
        expect(fixture.unexpected).toEqual([]);
      });
    }
  }
});
