import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mockEvent, PLAN_ID, ready } from './fixtures';
import { rpcValue } from '../test-support/rpcBatch';

for (const theme of ['dark', 'light'] as const) {
  for (const width of [390, 1440]) {
    test(`a private pending receipt settles a lost response in ${theme} at ${width}px`, async ({
      page,
    }, testInfo) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      const fixture = await mockEvent(page, { role: 'player' });
      const match = fixture.snapshot.matches.find((item) => item.status === 'playing')!;
      match.player2Name = 'Another Challenger with a Long Tournament Alias';
      const report = {
        id: 'lost-score-receipt',
        requestId: '',
        matchId: match.id,
        score1: 2,
        score2: 1,
        status: 'pending',
        isDispute: false,
      };
      let releaseResponse!: () => void;
      const responseReleased = new Promise<void>((resolve) => {
        releaseResponse = resolve;
      });
      const receiptBeforeFailure = width === 390;
      const procedure = 'eventOps.reportScore';
      await page.route('**/api/trpc/eventOps.reportScore*', async (route) => {
        report.requestId = rpcValue<{ requestId: string }>(
          route.request().url(),
          route.request().postDataJSON(),
          procedure,
        ).requestId;
        if (receiptBeforeFailure) {
          fixture.responses['eventOps.myReports'] = [report];
          await responseReleased;
        }
        await route.abort('connectionreset');
      });
      await page.goto(`/play/${PLAN_ID}`);
      const card = page.getByRole('article', {
        name: `${match.player1Name} vs ${match.player2Name}`,
      });
      await card.getByRole('spinbutton').nth(0).fill('2');
      await card.getByRole('spinbutton').nth(1).fill('1');
      const submit = card.getByRole('button', { name: 'Submit score for TO approval' });
      await submit.focus();
      await expect(submit).toBeFocused();
      await page.keyboard.press('Enter');
      const receipt = card.getByRole('status').filter({ hasText: 'Your report:' });
      if (receiptBeforeFailure) {
        const responseFailed = page.waitForEvent('requestfailed', (request) =>
          request.url().includes(procedure),
        );
        try {
          await expect(receipt).toHaveText('Your report: 2 – 1 · Awaiting TO approval');
        } finally {
          releaseResponse();
        }
        await responseFailed;
        await ready(page);
      } else {
        const alert = card.getByRole('alert');
        await expect(alert).toContainText(/fetch|network|connection/i);
        const other = fixture.snapshot.matches.find((item) => item.id !== match.id)!;
        fixture.responses['eventOps.myReports'] = [
          { ...report, id: 'older-report', requestId: 'different-request' },
          { ...report, id: 'other-match', matchId: other.id },
        ];
        await expect(receipt).toHaveText('Your report: 2 – 1 · Awaiting TO approval');
        await expect(alert).toContainText(/fetch|network|connection/i);
        fixture.responses['eventOps.myReports'] = [report];
      }
      await expect(receipt).toHaveText('Your report: 2 – 1 · Awaiting TO approval');
      await expect(card.getByRole('status')).toHaveCount(1);
      await expect(card.getByRole('alert')).toHaveCount(0);
      await expect(submit).toHaveCount(0);
      await ready(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
          .violations,
      ).toEqual([]);
      await card.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath('recovered-private-score-receipt.png') });
    });
  }
}
