import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { PublicEventSnapshot } from '../src/lib/usePlayerEventHub';
import { chooseOption } from '../test-support/controls';
import { darwinBaseline, darwinScreenshot } from './darwinScreenshot';
import { mockEvent, PLAN_ID, PLAYER_NAME, ready } from './fixtures';

type PendingField = NonNullable<PublicEventSnapshot['pendingFinals']>[number];
const pendingField: PendingField = {
  division: 'lower',
  stage: 'main',
  slots: [
    {
      poolId: 'lower-0',
      poolIndex: 0,
      division: 'lower',
      place: 1,
      status: 'pending',
      entrantId: null,
    },
  ],
};

async function finishedPools(page: Page) {
  const fixture = await mockEvent(page, { bracket: true, idle: true });
  const { snapshot } = fixture;
  const pools = snapshot.matches.filter((match) => match.stage === 'group');
  for (const match of pools)
    Object.assign(match, {
      status: 'complete',
      outcome: 'played',
      score1: 2,
      score2: 0,
      winnerId: match.player1Id,
    });
  const beforeDraw = {
    ...snapshot,
    plan: { ...snapshot.plan, structure: 'dual_division' },
    matches: pools,
    nativeBrackets: [],
    pendingFinals: [pendingField],
  };
  fixture.responses['eventOps.snapshot'] = beforeDraw;
  return { fixture, beforeDraw, afterDraw: { ...snapshot, plan: beforeDraw.plan } };
}

const progress = (page: Page) => page.locator('.player-event-overview');
const pendingCopy = 'The finals draw is pending.';

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test(`${theme} ${width}px completed pools distinguish pending and published finals`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const { fixture, beforeDraw, afterDraw } = await finishedPools(page);
      await page.goto(`/play/${PLAN_ID}`);
      const total = beforeDraw.matches.length;
      await expect(progress(page)).toContainText(
        `Pool progress · ${total} / ${total} sets complete`,
      );
      await expect(page.getByRole('complementary', { name: 'Event progress' })).toHaveCount(0);
      const bar = progress(page).getByRole('progressbar', { name: 'Pool sets completed' });
      await expect(bar).toHaveAccessibleDescription(pendingCopy);
      await expect(bar).toHaveAttribute('value', String(total));
      await expect(bar).toHaveAttribute('max', String(total));
      await ready(page);
      await page.screenshot({ path: testInfo.outputPath('pools-complete-finals-pending.png') });

      const bracketLink = page.getByRole('link', { name: 'Brackets', exact: true });
      await bracketLink.focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/#event-brackets$/);
      await expect(page.getByRole('heading', { name: 'Finals qualification' })).toBeVisible();
      const poolFilter = page.getByRole('combobox', { name: 'Your pool' });
      const first = beforeDraw.matches.find((match) => match.player1Name === PLAYER_NAME)!;
      const poolCount = beforeDraw.matches.filter(
        ({ division, poolIndex }) => division === first.division && poolIndex === first.poolIndex,
      ).length;
      await chooseOption(poolFilter, `${first.division}:${first.poolIndex}`);
      await expect(bar).toHaveAttribute('value', String(poolCount));
      await expect(bar).toHaveAttribute('max', String(poolCount));
      await expect(page.locator('#event-results')).toContainText(PLAYER_NAME);
      await ready(page);
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

      fixture.responses['eventOps.snapshot'] = { ...afterDraw, pendingFinals: [pendingField] };
      await page.goto(`/play/${PLAN_ID}`);
      const completed = afterDraw.matches.filter((match) => match.status === 'complete').length;
      await expect(progress(page)).toContainText(
        `Event progress · ${completed} / ${afterDraw.matches.length} sets complete`,
      );
      await expect(progress(page).getByRole('progressbar')).toHaveAccessibleDescription(
        'The remaining finals draws are pending.',
      );
      await expect(page.locator('.event-bracket-match').first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );

      fixture.responses['eventOps.snapshot'] = afterDraw;
      await page.reload();
      await expect(progress(page)).toHaveText(
        `Event progress · ${completed} / ${afterDraw.matches.length} sets complete`,
      );
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.submissions).toEqual([]);
    });

test(
  'pre-draw phone progress uses the shared light-theme progress bar',
  darwinBaseline,
  async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => localStorage.setItem('smashclub:theme', 'light'));
    await finishedPools(page);
    await page.goto(`/play/${PLAN_ID}`);
    await expect(progress(page).getByRole('progressbar')).toHaveAccessibleDescription(pendingCopy);
    await ready(page);
    await darwinScreenshot(page, 'pool-progress-finals-pending-phone.png');
  },
);

test('only an open native pool-and-finals event implies an unpublished finals draw', async ({
  page,
}) => {
  const { fixture, beforeDraw } = await finishedPools(page);
  const total = beforeDraw.matches.length;
  const { plan } = beforeDraw;
  for (const variation of [
    { ...beforeDraw, plan: { ...plan, structure: 'round_robin' } },
    { ...beforeDraw, plan: { ...plan, structure: 'single_elimination' } },
    { ...beforeDraw, plan: { ...plan, structure: undefined } },
    { ...beforeDraw, plan: { ...plan, status: 'complete' } },
    { ...beforeDraw, plan: { ...plan, status: 'cancelled' } },
    { ...beforeDraw, plan: { ...plan, status: 'draft' } },
    { ...beforeDraw, plan: { ...plan, bracketMode: 'challonge' } },
    { ...beforeDraw, brackets: [{ slug: 'linked-finals', stage: 'main', division: 'upper' }] },
  ]) {
    fixture.responses['eventOps.snapshot'] = variation;
    await page.goto(`/play/${PLAN_ID}`);
    await expect(progress(page)).toHaveText(`Event progress · ${total} / ${total} sets complete`);
    await expect(
      progress(page).getByRole('progressbar', { name: 'Sets completed', exact: true }),
    ).toBeVisible();
  }
  fixture.responses['eventOps.snapshot'] = {
    ...beforeDraw,
    plan: { ...plan, structure: 'round_robin_finals' },
    pendingFinals: [],
  };
  await page.goto(`/play/${PLAN_ID}`);
  await expect(progress(page)).toContainText(pendingCopy);
  expect(fixture.unexpected).toEqual([]);
});
