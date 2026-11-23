import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mockEvent, ready } from './fixtures';

for (const theme of ['dark', 'light'] as const) {
  for (const width of [390, 1440]) {
    test(`changelog leads with user changes at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const { unexpected } = await mockEvent(page);
      // 0.3.0 has a feature with setup instructions and an illustration, as well as fixes
      // and a maintenance note. It exercises grouping and the existing version anchor.
      await page.goto('/changelog#030');
      await ready(page);

      const content = page.getByRole('main');
      const versionHeading = content.getByRole('heading', { level: 2, name: '0.3.0', exact: true });
      const versionLink = versionHeading.getByRole('link');
      await expect(versionLink).toHaveAttribute('href', /\/releases\/tag\/v0\.3\.0$/);
      // Keep release anchors and the version link clear of the sticky navigation.
      await expect
        .poll(async () => {
          const { y } = (await versionHeading.boundingBox())!;
          const navigationBottom = await page
            .locator('nav.app-nav')
            .evaluate((header) => header.getBoundingClientRect().bottom);
          return y >= navigationBottom && y < (page.viewportSize()?.height ?? 0);
        })
        .toBe(true);

      // Read the groups between this release and the next header, without relying on
      // the most recent release number.
      const release = versionHeading.locator(
        'xpath=following-sibling::*[preceding-sibling::h2[1][@id="030"] and not(self::h2)]',
      );
      await expect(release.and(content.getByRole('heading', { level: 3 }))).toHaveText([
        'New and improved',
        'Fixes',
        'Maintenance',
      ]);
      const feature = release.getByRole('listitem').filter({ hasText: 'Add an optional Twitch' });
      await expect(feature).toContainText('Press S on the overlay');
      const screenshot = feature.getByRole('img', { name: /OBS Progress scene/ });
      await screenshot.scrollIntoViewIfNeeded();
      await expect(screenshot).toHaveJSProperty('complete', true);
      expect(
        await screenshot.evaluate((img: HTMLImageElement) => img.naturalWidth),
      ).toBeGreaterThan(0);
      await expect(screenshot).toHaveAttribute('src', '/changelog/obs-twitch-link.png');
      await expect(feature.getByRole('link', { name: '#247', exact: true })).toHaveAttribute(
        'href',
        /\/pull\/247$/,
      );
      await expect(feature.getByRole('link', { name: /^build / })).toHaveAttribute(
        'href',
        /\/commit\/[a-f\d]{40}$/,
      );
      await expect(
        content.getByRole('heading', { name: 'Before versioned releases' }),
      ).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);

      await versionLink.focus();
      await page.keyboard.press('Tab');
      await expect(feature.getByRole('link', { name: '#247', exact: true })).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(feature.getByRole('link', { name: /^build / })).toBeFocused();

      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
          .violations,
      ).toEqual([]);
      await versionHeading.evaluate((heading) => heading.scrollIntoView());
      await page.screenshot({ path: testInfo.outputPath('mixed-release.png') });
      expect(unexpected).toEqual([]);
    });
  }
}
