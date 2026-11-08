import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mockEvent, PLAN_ID, ready } from './fixtures';

const poolRuling = {
  poolId: 'upper-b',
  poolIndex: 1,
  division: 'upper',
  place: 2,
  status: 'pending',
};
const rulingReason = 'Set wins decide the clear places. Confirm a ruling for the tied places.';

for (const theme of ['dark', 'light'] as const) {
  for (const width of [390, 1440]) {
    test(`assigned organiser can open the exact pending pool order at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const { overview, unexpected } = await mockEvent(page, { role: 'player', bracket: true });
      for (const poolIndex of [0, 1]) {
        const poolMatches = overview.matches.filter(
          (match) => match.division === 'upper' && match.poolIndex === poolIndex,
        );
        const entrants = [
          ...new Set(poolMatches.flatMap((match) => [match.player1Id, match.player2Id])),
        ];
        for (const match of poolMatches) {
          const first = entrants.indexOf(match.player1Id);
          const second = entrants.indexOf(match.player2Id);
          const reversesTie =
            poolIndex === 1 && Math.min(first, second) === 0 && Math.abs(first - second) === 2;
          const firstWins = first < second !== reversesTie;
          Object.assign(match, {
            status: 'complete',
            started: true,
            stationId: null,
            score1: firstWins ? 2 : 0,
            score2: firstWins ? 0 : 2,
            winnerId: firstWins ? match.player1Id : match.player2Id,
            outcome: 'played',
          });
        }
      }
      overview.stationQueues = [];

      const [waiting, held] = overview.matches.filter((match) => match.status === 'blocked');
      Object.assign(waiting!, {
        blockedReason: 'Waiting for qualification: upper pool B place 2 (finishing order)',
        qualificationWait: true,
        qualificationBlocks: [poolRuling],
      });
      Object.assign(held!, {
        blockedReason: 'Organiser hold',
        qualificationBlocks: [poolRuling],
      });
      const reported = overview.matches.find(
        (match) => match.division === 'lower' && match.poolIndex === 1,
      )!;
      overview.reports = [
        {
          ...overview.reports[0]!,
          matchId: reported.id,
          status: 'pending',
          expectedRevision: reported.revision,
        },
      ];
      Object.assign(overview, {
        poolOrders: [
          {
            poolId: 'upper-a',
            division: 'upper',
            poolIndex: 0,
            status: 'automatic',
            reason: 'Decided automatically.',
          },
          {
            poolId: 'upper-b',
            division: 'upper',
            poolIndex: 1,
            status: 'partial',
            reason: rulingReason,
            plannerConfirmation: { available: true },
          },
          {
            poolId: 'lower-a',
            division: 'lower',
            poolIndex: 0,
            status: 'manual_required',
            reason: 'Confirm the pool order.',
            plannerConfirmation: {
              available: false,
              reason: 'This order cannot be restored after finals used it.',
            },
          },
          {
            poolId: 'lower-b',
            division: 'lower',
            poolIndex: 1,
            status: 'review_pending',
            reason: 'Resolve current score reports.',
          },
          {
            poolId: 'unknown',
            division: 'upper',
            poolIndex: 7,
            status: 'ruling_required',
            reason: 'A ruling is required.',
            plannerConfirmation: { available: true },
          },
        ],
      });
      await page.goto(`/operate/${PLAN_ID}`);
      const attention = page.getByRole('region', { name: /Needs attention/ });
      await expect(attention.getByRole('heading')).toHaveText('Needs attention 3');
      await expect(attention.getByRole('button', { name: 'Score reviews · 1' })).toBeVisible();
      await expect(attention.getByRole('button', { name: 'Match decisions · 1' })).toBeVisible();
      const disclosure = attention.getByRole('button', { name: 'Pool orders · 1' });
      await disclosure.press('Enter');
      await page.keyboard.press('Tab');
      const review = attention.getByRole('button', {
        name: 'Review pool order for upper · Pool B',
        exact: true,
      });
      await expect(review).toBeFocused();
      await review.press('Enter');
      await expect(
        page.getByRole('tab', { name: 'Standings / draw', exact: true }),
      ).toHaveAttribute('aria-selected', 'true');
      const standings = page.getByRole('region', { name: 'Pool standings', exact: true });
      const pool = standings.getByRole('region', { name: 'upper · Pool B', exact: true });
      const heading = pool.getByRole('heading');
      await expect(heading).toBeFocused();
      await expect(heading).toHaveAccessibleDescription(rulingReason);
      await expect(
        standings.getByText('Ask an event administrator to confirm the outstanding pool orders.'),
      ).toBeVisible();
      await expect(standings.getByRole('link', { name: /planner/ })).toHaveCount(0);
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
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await page.screenshot({
        path: testInfo.outputPath('pool-ruling-attention.png'),
        fullPage: true,
      });
      expect(unexpected).toEqual([]);
    });
  }
}
