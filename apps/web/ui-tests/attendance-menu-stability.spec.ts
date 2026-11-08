import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mockEvent, PLAN_ID, PLAYER_NAME, ready } from './fixtures';

for (const theme of ['dark', 'light'] as const) {
  for (const width of [390, 1440]) {
    test(`attendance menu stays reachable while the roster loads at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      const height = width === 390 ? 844 : 900;
      await page.setViewportSize({ width, height });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const fixture = await mockEvent(page, { role: 'admin' });
      Object.assign(fixture.overview.plan, { bracketMode: 'challonge', liveOwned: false });
      fixture.responses['eventOps.delivery.status'] = { configured: false };
      const attendees = fixture.overview.entrants.slice(0, 16).map((entrant, index) => ({
        entryId: `roster-entry-${index}`,
        playerId: entrant.id,
        publicAlias: index === 0 ? PLAYER_NAME : entrant.name,
        canonicalName: entrant.name,
        displayName: null,
        rawInput: entrant.name,
        cleanedName: entrant.name,
        division: index < 8 ? 'upper' : 'lower',
        companyCode: null,
        companyName: null,
      }));
      fixture.responses['eventOps.attendeeRoster'] = { attendees, companies: [] };

      let releaseRoster!: () => void;
      const waitForRoster = new Promise<void>((resolve) => {
        releaseRoster = resolve;
      });
      await page.route(/\/api\/trpc\/.*eventOps\.attendeeRoster/, async (route) => {
        await waitForRoster;
        await route.fallback();
      });

      await page.goto(`/admin/event-operations?plan=${PLAN_ID}&view=players`);
      const attendance = page
        .locator('section.card')
        .filter({ has: page.getByRole('heading', { name: 'Attendance changes', exact: true }) });
      const action = attendance.getByRole('combobox', { name: 'Change', exact: true });
      const roster = page.locator('#attendee-list');
      const rows = roster.locator('tbody tr');
      const menu = page.getByRole('listbox');
      const withdraw = menu.getByRole('option', { name: 'Withdraw an entrant after play' });
      try {
        await expect(roster).toContainText('Loading attendees…');
        await expect(action).toBeEnabled();
        await ready(page);
        await action.evaluate((element) => {
          const desiredTop = innerHeight * 0.85;
          const top = element.getBoundingClientRect().top;
          if (top > desiredTop) scrollBy(0, top - desiredTop);
        });
        const trigger = (await action.boundingBox())!;
        expect(trigger.y).toBeGreaterThan(height * 0.65);
        expect(trigger.y + trigger.height).toBeLessThanOrEqual(height);
        await action.click();
        await expect(withdraw).toBeInViewport();
      } finally {
        releaseRoster();
      }

      await expect(rows).toHaveCount(attendees.length);
      await ready(page);
      await expect(withdraw).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath('roster-arrived-with-menu-open.png') });
      await withdraw.click();
      await expect(menu).toBeHidden();
      await expect(action).toHaveAttribute('data-value', 'withdraw');

      await action.focus();
      await page.keyboard.press('Enter');
      await expect(menu).toBeVisible();
      await page.keyboard.press('Home');
      await expect(menu.getByRole('option', { name: 'Add a late arrival' })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(action).toBeFocused();
      await expect(action).toHaveAttribute('data-value', 'withdraw');
      await expect(roster).toContainText(PLAYER_NAME);

      await page.evaluate(() => scrollTo(0, 0));
      await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
      await page.mouse.move(0, 0);
      await ready(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(
        (
          await new AxeBuilder({ page })
            .include('.ops-page')
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath('players-after-roster-load.png'),
        fullPage: true,
      });
      expect(fixture.unexpected).toEqual([]);
    });
  }
}
