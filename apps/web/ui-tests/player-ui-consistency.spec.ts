import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mockEvent, PLAN_ID, ready } from './fixtures';
import { chooseOption } from '../test-support/controls';

for (const theme of ['dark', 'light'] as const) {
  for (const width of [390, 1440]) {
    for (const closed of [false, true]) {
      test(`${theme} ${width}px ${closed ? 'completed' : 'active'} player hub follows shared app styling`, async ({
        page,
      }, testInfo) => {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
        const fixture = await mockEvent(page, { role: 'player', bracket: true });
        const current = fixture.snapshot.matches.find((m) => m.status === 'playing')!;
        if (closed) {
          Object.assign(fixture.snapshot.plan, { status: 'complete' });
          for (const match of fixture.snapshot.matches) {
            if (match.outcome === 'bye') continue;
            Object.assign(match, {
              status: 'complete',
              outcome: match.player1Id && match.player2Id ? 'played' : null,
              winnerId: match.player1Id && match.player2Id ? match.player1Id : null,
              score1: match.player1Id && match.player2Id ? 2 : null,
              score2: match.player1Id && match.player2Id ? 0 : null,
            });
          }
          fixture.responses['eventOps.myReports'] = [
            {
              id: 'private-approved',
              matchId: current.id,
              score1: 2,
              score2: 0,
              outcome: 'played',
              status: 'approved',
              isDispute: false,
              winnerId: current.player1Id,
            },
          ];
        }
        await page.goto(`/play/${PLAN_ID}?player=${current.player1Id}`);
        const progress = page.getByRole('complementary', { name: 'Your progress' });
        await expect(progress).toBeVisible();
        await expect(
          page.getByRole('progressbar', { name: 'Your matches completed' }),
        ).toHaveAttribute('max');
        await expect(page.getByRole('progressbar', { name: 'Sets completed' })).toHaveCSS(
          'appearance',
          'none',
        );
        await expect(page.getByRole('progressbar', { name: 'Your matches completed' })).toHaveCSS(
          'border-radius',
          '0px',
        );
        await expect(page.getByRole('link', { name: 'Brackets', exact: true })).toBeVisible();
        if (closed) {
          await expect(progress).toContainText('This event is closed');
          await expect(
            page.getByText('Recorded tournament results', { exact: true }),
          ).toBeVisible();
          await expect(page.getByText('This event is closed', { exact: false })).toHaveCount(1);
          await expect(
            page.getByText('Live event · results refresh automatically', { exact: true }),
          ).toHaveCount(0);
          await expect(
            page.getByText('Showing your upcoming matches', { exact: false }),
          ).toHaveCount(0);
          await expect(
            page.getByRole('button', { name: 'Find next match', exact: true }),
          ).toHaveCount(0);
          await expect(page.locator('article.ops-match').getByRole('spinbutton')).toHaveCount(0);
        } else {
          await expect(
            page
              .locator('article.ops-match')
              .filter({ hasText: current.label })
              .getByRole('spinbutton'),
          ).toHaveCount(2);
        }
        await page.getByRole('link', { name: 'Brackets', exact: true }).click();
        await expect(page).toHaveURL(/#event-brackets$/);
        await page
          .getByRole('button', { name: 'Full draw & bracket standings', exact: true })
          .click();
        await expect(page.locator('.event-brackets')).toBeVisible();
        await ready(page);
        expect(
          (
            await new AxeBuilder({ page })
              .include('.player-event-hub')
              .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
              .analyze()
          ).violations,
        ).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await page.evaluate(() => scrollTo(0, 0));
        await page.mouse.move(0, 0);
        await ready(page);
        await page.screenshot({
          path: testInfo.outputPath(
            `player-hub-${closed ? 'closed' : 'active'}-${theme}-${width}.png`,
          ),
          fullPage: true,
        });
        if (closed)
          await expect(page).toHaveScreenshot(`player-hub-closed-${theme}-${width}.png`, {
            fullPage: true,
          });
        expect(fixture.unexpected).toEqual([]);
      });
    }
  }
}

for (const theme of ['dark', 'light'] as const) {
  for (const width of [390, 1440]) {
    test(`${theme} ${width}px recent TO side and attendance controls retain shared styling`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const fixture = await mockEvent(page, { role: 'admin' });
      Object.assign(fixture.snapshot.plan, { bracketMode: 'native', liveOwned: true });
      Object.assign(fixture.overview.plan, { bracketMode: 'native', liveOwned: true });
      await page.goto(`/operate/${PLAN_ID}?view=broadcast`);
      const broadcast = page.getByRole('tabpanel', { name: 'Broadcast', exact: true });
      await expect(
        broadcast.getByRole('button', { name: 'Swap players / sides', exact: true }),
      ).toBeVisible();
      for (const view of ['broadcast', 'players']) {
        if (view === 'players') {
          await page.getByRole('tab', { name: 'Players', exact: true }).click();
          const panel = page.getByRole('tabpanel', { name: 'Players', exact: true });
          await chooseOption(
            panel.getByRole('combobox', { name: 'Change', exact: true }),
            'restore',
          );
          await expect(
            panel.getByRole('heading', { name: 'Attendance history', exact: true }),
          ).toBeVisible();
          await expect(
            panel.getByRole('button', { name: 'Preview attendance change', exact: true }),
          ).toBeDisabled();
        }
        await page.evaluate(() => scrollTo(0, 0));
        await page.mouse.move(0, 0);
        await ready(page);
        expect(
          (
            await new AxeBuilder({ page })
              .include('.ops-page')
              .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
              .analyze()
          ).violations,
        ).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await page.screenshot({
          path: testInfo.outputPath(`audit-${view}-${theme}-${width}.png`),
          fullPage: true,
        });
      }
      expect(fixture.unexpected).toEqual([]);
    });
  }
}
