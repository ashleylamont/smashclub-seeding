import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mockEvent, PLAN_ID, ready } from './fixtures';

test('assigned organisers are directed to the appropriate score review or administrator', async ({
  page,
}) => {
  const fixture = await mockEvent(page, { role: 'player', bracket: true });
  Object.assign(fixture.overview, {
    poolOrders: [
      {
        division: 'upper',
        poolIndex: 0,
        status: 'review_pending',
        reason: 'Resolve current score reports before deciding this pool order.',
      },
      {
        division: 'upper',
        poolIndex: 1,
        status: 'partial',
        reason: 'Set wins decide the clear places. Confirm a ruling for the tied places.',
        plannerConfirmation: { available: true },
      },
      {
        division: 'lower',
        poolIndex: 0,
        status: 'manual_required',
        reason: 'This event uses organiser-confirmed pool orders.',
        plannerConfirmation: {
          available: false,
          reason:
            'The confirmed order is missing. This worksheet cannot restore it after finals used it.',
        },
      },
      {
        division: 'lower',
        poolIndex: 1,
        status: 'retained_after_correction',
        reason:
          'A reviewed result correction changed this pool. Its recorded order and finals qualifiers remain fixed.',
      },
    ],
  });

  await page.goto(`/operate/${PLAN_ID}?view=draw`);
  const standings = page.getByRole('region', { name: 'Pool standings', exact: true });
  await expect(standings).toContainText('Score review pending.');
  await expect(standings).not.toContainText('before deciding this pool order');
  await expect(standings).toContainText('Confirm a ruling for the tied places.');
  await expect(standings).toContainText('The confirmed order is missing.');
  await expect(standings).toContainText('Its recorded order and finals qualifiers remain fixed.');
  await expect(standings).toContainText('Ask an event administrator');
  await expect(standings.getByRole('link', { name: /planner/ })).toHaveCount(0);
  await standings.getByRole('button', { name: 'Review score submissions' }).press('Enter');
  await expect(page.getByRole('region', { name: 'Score submissions' })).toBeFocused();
  expect(fixture.unexpected).toEqual([]);
});

test('linked and older standings keep the recorded-order fallback without a planner action', async ({
  page,
}, testInfo) => {
  const fixture = await mockEvent(page, { role: 'admin' });
  Object.assign(fixture.overview.plan, { bracketMode: 'challonge', liveOwned: false });
  fixture.responses['eventOps.delivery.status'] = { configured: false };
  await page.goto(`/operate/${PLAN_ID}?view=draw`);
  const standings = page.getByRole('region', { name: 'Pool standings', exact: true });
  await expect(standings).toContainText('Use the linked bracket or the organiser’s recorded order');
  await expect(standings.getByRole('link', { name: /planner/ })).toHaveCount(0);
  await expect(standings.getByRole('button', { name: 'Review score submissions' })).toHaveCount(0);
  await ready(page);
  await page.screenshot({ path: testInfo.outputPath('linked-pool-standings.png'), fullPage: true });
  expect(fixture.unexpected).toEqual([]);
});

for (const theme of ['dark', 'light'] as const) {
  for (const width of [390, 1440]) {
    test(`${theme} ${width}px blocked pool orders explain why confirmation is unavailable`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const fixture = await mockEvent(page, { role: 'admin', idle: true });
      Object.assign(fixture.overview.plan, { drawPaused: true });
      Object.assign(fixture.overview, {
        poolOrders: [
          {
            division: 'upper',
            poolIndex: 0,
            status: 'manual_required',
            plannerConfirmation: {
              available: false,
              reason: 'Resume the pool draw to confirm this order.',
            },
          },
          {
            division: 'lower',
            poolIndex: 0,
            status: 'ruling_required',
            plannerConfirmation: {
              available: false,
              reason: 'This pool order cannot be confirmed while the finals draw is in use.',
            },
          },
        ],
      });

      await page.goto(`/operate/${PLAN_ID}?view=draw`);
      const standings = page.getByRole('region', { name: 'Pool standings', exact: true });
      await expect(standings).toContainText('Resume the pool draw to confirm this order.');
      await expect(standings).toContainText(
        'This pool order cannot be confirmed while the finals draw is in use.',
      );
      await expect(standings.getByRole('link', { name: /planner/ })).toHaveCount(0);
      await ready(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(
        (
          await new AxeBuilder({ page })
            .include('section[aria-labelledby="ops-pool-standings-title"]')
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath('blocked-pool-standings.png'),
        fullPage: true,
      });
      expect(fixture.unexpected).toEqual([]);
    });
  }
}
