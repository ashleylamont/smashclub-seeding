import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mockEvent, PLAN_ID, ready } from './fixtures';

const route = `/admin/event-operations?plan=${PLAN_ID}&view=settings`;
const stationName = 'North Hall Main Stage with a long station name';
const settings = { enabled: true, showOnOverlay: false, rotateInvitations: false };

async function stationSigns(page: Page) {
  const fixture = await mockEvent(page, { role: 'admin' });
  fixture.overview.stations[0]!.name = stationName;
  fixture.responses['eventOps.guests.settings'] = settings;
  fixture.responses['eventOps.guests.invitation'] = {
    token: 'persistent.synthetic-station-sign',
    expiresAt: null,
  };
  return fixture;
}

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test.describe(`station sign preview at ${width}px in ${theme}`, () => {
      test.use({ colorScheme: theme, viewport: { width, height: width === 390 ? 844 : 900 } });

      test('returns keyboard focus after closing the sign preview', async ({ page }, testInfo) => {
        const { unexpected } = await stationSigns(page);
        await page.goto(route);
        const launch = page.getByRole('button', { name: 'Print station signs', exact: true });
        await expect(launch).toBeEnabled();
        await ready(page);
        const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        await launch.focus();
        await page.keyboard.press('Enter');

        const preview = page.getByRole('dialog', { name: 'Print station signs', exact: true });
        await expect(preview.getByRole('button', { name: 'Close dialog' })).toBeFocused();
        await expect(preview.getByRole('button', { name: 'Print selected signs' })).toBeEnabled();
        await preview.getByRole('checkbox', { name: 'Setup 2', exact: true }).press('Space');
        const sign = preview.getByRole('article');
        await expect(sign).toHaveCount(1);
        await expect(sign.getByRole('heading', { name: stationName, exact: true })).toBeVisible();
        await expect(
          sign.getByRole('img', { name: `Guest score reporting QR for ${stationName}` }),
        ).toBeVisible();
        await ready(page);
        expect(await preview.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(pageWidth);
        expect(
          (
            await new AxeBuilder({ page })
              .include('.station-sign-toolbar')
              .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
              .analyze()
          ).violations,
        ).toEqual([]);
        await page.screenshot({ path: testInfo.outputPath('station-sign-preview.png') });

        if (width === 390) await page.keyboard.press('Escape');
        else await preview.getByRole('button', { name: 'Close preview' }).press('Enter');
        await expect(preview).toBeHidden();
        await expect(launch).toBeFocused();
        await expect(page.locator('body')).not.toHaveClass(/printing-station-signs/);
        await page.screenshot({ path: testInfo.outputPath('station-sign-return-focus.png') });
        expect(unexpected).toEqual([]);
      });
    });

test('returns to the launcher while guest settings still refresh', async ({ page }) => {
  const { mutationResponses, responses, unexpected } = await stationSigns(page);
  let issueCount = 0;
  mutationResponses.set('eventOps.guests.invitation', () => {
    issueCount += 1;
    return responses['eventOps.guests.invitation'];
  });
  let settingsRequested!: () => void;
  const refetchStarted = new Promise<void>((resolve) => {
    settingsRequested = resolve;
  });
  let releaseRefresh!: () => void;
  const refreshReleased = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  await page.route(
    (url) =>
      url.pathname.split('/').at(-1)?.split(',').includes('eventOps.guests.settings') ?? false,
    async (route) => {
      if (issueCount) {
        settingsRequested();
        await refreshReleased;
      }
      await route.fallback();
    },
  );

  try {
    await page.goto(route);
    const launch = page.getByRole('button', { name: 'Print station signs', exact: true });
    await expect(launch).toBeEnabled();
    await launch.press('Enter');
    const preview = page.getByRole('dialog', { name: 'Print station signs', exact: true });
    await expect(preview.getByRole('button', { name: 'Print selected signs' })).toBeEnabled();
    await refetchStarted;

    await page.keyboard.press('Escape');
    await expect(preview).toBeHidden();
    await expect(launch).toBeFocused();
    await expect(launch).toBeDisabled();
    await page.keyboard.press('Enter');
    await expect(preview).toBeHidden();
    releaseRefresh();
    await expect(launch).toBeEnabled();
    expect(issueCount).toBe(1);
    expect(unexpected).toEqual([]);
  } finally {
    releaseRefresh();
  }
});
