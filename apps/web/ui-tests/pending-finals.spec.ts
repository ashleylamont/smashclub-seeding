import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { PublicEventSnapshot } from '../src/lib/usePlayerEventHub';
import { bracketCaptureOptions, mockEvent, PLAN_ID, ready } from './fixtures';

type PendingField = NonNullable<PublicEventSnapshot['pendingFinals']>[number];
const longPair = 'Alexandra with a long tournament alias / CaptainABCDEFGHIJKLMNOPQRSTUVWXYZ';

for (const theme of ['dark', 'light'] as const) {
  for (const width of [390, 1440]) {
    test(`${theme} ${width}px public finals progress from pool places to published pairings`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const fixture = await mockEvent(page, { bracket: true });
      const { snapshot } = fixture;
      const [published] = snapshot.nativeBrackets;
      const playerId = published!.entrantIds[0]!;
      const entrant = snapshot.entrants.find((item) => item.id === playerId)!;
      entrant.name = longPair;
      const pool = snapshot.matches.find(
        (m) => m.stage === 'group' && [m.player1Id, m.player2Id].includes(playerId),
      )!;
      const fields: PendingField[] = [];
      for (const division of ['upper', 'lower'] as const)
        for (const stage of ['main', 'consolation'] as const)
          fields.push({
            division,
            stage,
            slots: [0, 1].map((poolIndex) => ({
              poolId: `${division}-${poolIndex}`,
              poolIndex,
              division,
              place: stage === 'main' ? 1 : 3,
              status: division === 'lower' && poolIndex === 1 ? 'review_pending' : 'pending',
              entrantId: null,
            })),
          });
      const poolMatches = snapshot.matches.filter((m) => m.stage === 'group');
      const poolSnapshot = {
        ...snapshot,
        matches: poolMatches,
        nativeBrackets: [],
        pendingFinals: fields,
      };
      fixture.responses['eventOps.snapshot'] = poolSnapshot;

      await page.goto(`/play/${PLAN_ID}`);
      const nav = page.getByRole('link', { name: 'Brackets', exact: true });
      await nav.focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/#event-brackets$/);
      const brackets = page.getByRole('region', { name: 'Brackets', exact: true });
      const pending = brackets.locator('.pending-finals');
      await expect(pending.getByRole('heading', { name: 'Finals qualification' })).toBeVisible();
      await expect(pending.getByRole('article')).toHaveCount(4);
      await expect(pending).toContainText('Upper Pool A · place 1');
      await expect(pending).toContainText('Lower Pool B · place 3');
      await expect(pending).toContainText('Under score review');
      await expect(pending).toContainText(
        'Planned seeding combines pool place and frozen WHR rating',
      );
      await expect(brackets).not.toContainText(longPair);
      await expect(brackets.locator('.event-bracket-match')).toHaveCount(0);

      const playerSlot = fields[0]!.slots.find((slot) => slot.poolIndex === pool.poolIndex)!;
      Object.assign(playerSlot, { status: 'resolved', entrantId: playerId });
      await page.reload();
      await expect(pending.getByText(longPair, { exact: true })).toBeVisible();
      await expect(brackets.locator('.event-bracket-match')).toHaveCount(0);
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
      await brackets.screenshot({
        path: testInfo.outputPath(`pending-finals-${theme}-${width}.png`),
        ...bracketCaptureOptions,
      });

      await page.goto(`/play/${PLAN_ID}?player=${playerId}#event-brackets`);
      await expect(pending.getByText(longPair, { exact: true })).toBeVisible();
      await expect(pending).not.toContainText('Lower');
      await expect(pending.getByRole('listitem')).toHaveCount(2);

      fixture.responses['eventOps.snapshot'] = { ...snapshot, pendingFinals: fields.slice(1) };
      await page.goto(`/play/${PLAN_ID}#event-brackets`);
      await expect(brackets.locator('.event-bracket-match').first()).toBeVisible();
      await expect(pending.getByRole('heading', { name: 'Upper Championship' })).toHaveCount(0);
      await expect(pending.getByRole('heading', { name: 'Lower Championship' })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await brackets.screenshot({
        path: testInfo.outputPath(`mixed-finals-${theme}-${width}.png`),
        ...bracketCaptureOptions,
      });
      expect(fixture.unexpected).toEqual([]);
    });
  }
}
