import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mockEvent, ready } from './fixtures';

for (const theme of ['dark', 'light'] as const) {
  for (const width of [390, 1440]) {
    test(`changelog keeps recent highlights in view at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const { unexpected } = await mockEvent(page);
      await page.goto('/changelog');
      await ready(page);

      const main = page.getByRole('main');
      const articles = main.getByRole('article');
      await expect(articles).toHaveCount(3);
      await expect(articles.first().locator('.changelog-highlights')).not.toBeEmpty();
      const older = main.getByRole('button', { name: 'Older releases' });
      await expect(older).toHaveAttribute('aria-expanded', 'false');
      await expect(main.getByRole('link', { name: /^build / })).toHaveCount(0);
      await expect(main.locator('img')).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath('recent-releases.png') });

      const latest = articles.first();
      const details = latest.getByRole('button', { name: /^Full notes for / });
      await details.focus();
      await expect(details).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(details).toHaveAttribute('aria-expanded', 'true');
      await expect(latest.getByRole('link', { name: /^build / }).first()).toBeVisible();
      await page.keyboard.press('Space');
      await expect(details).toHaveAttribute('aria-expanded', 'false');
      await expect(latest.getByRole('link', { name: /^build / })).toHaveCount(0);

      await older.focus();
      await page.keyboard.press('Enter');
      await expect(older).toHaveAttribute('aria-expanded', 'true');
      const oldVersion = main.getByRole('heading', { level: 2, name: '0.3.0', exact: true });
      await expect(oldVersion).toBeVisible();
      await expect(main.getByRole('button', { name: 'Full notes for 0.3.0' })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
      await expect(main.getByRole('button', { name: 'Archive notes' })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(unexpected).toEqual([]);
    });

    test(`changelog leads with user changes at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const { unexpected } = await mockEvent(page);
      // 0.3.0 has a feature with setup instructions and an illustration, as well as fixes
      // and a maintenance note. It exercises grouping and the existing version anchor.
      // Let the initial fragment scroll occur with fallback fonts in the reported light theme.
      let releaseFonts: (() => void) | undefined;
      if (theme === 'light') {
        const heldFonts = new Promise<void>((resolve) => {
          releaseFonts = resolve;
        });
        await page.route(/\.woff2?(\?.*)?$/, async (route) => {
          await heldFonts;
          await route.continue();
        });
      }
      const content = page.getByRole('main');
      const versionHeading = content.getByRole('heading', { level: 2, name: '0.3.0', exact: true });
      const versionLink = versionHeading.getByRole('link');
      try {
        await page.goto('/changelog#030', { waitUntil: 'domcontentloaded' });
        await expect(versionLink).toHaveAttribute('href', /\/releases\/tag\/v0\.3\.0$/);
        if (theme === 'light') {
          await expect(versionHeading).toBeInViewport();
          expect(await page.evaluate(() => document.fonts.status)).toBe('loading');
        }
      } finally {
        releaseFonts?.();
      }
      await ready(page);
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

      const release = content.getByRole('article', { name: '0.3.0', exact: true });
      await expect(content.getByRole('button', { name: 'Older releases' })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      const details = release.getByRole('button', { name: 'Full notes for 0.3.0' });
      await expect(details).toHaveAttribute('aria-expanded', 'true');
      const fullNotes = release.locator('.ui-disclosure-content');
      await expect(fullNotes.getByRole('heading', { level: 3 })).toHaveText([
        'New and improved',
        'Fixes',
        'Maintenance',
      ]);
      const feature = fullNotes.getByRole('listitem').filter({ hasText: 'Add an optional Twitch' });
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
      await expect(details).toBeFocused();
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

test('changelog reopens an older release and archive on same-page fragment navigation', async ({
  page,
}) => {
  await mockEvent(page);
  await page.goto('/changelog');
  const older = page.getByRole('button', { name: 'Older releases' });
  await expect(older).toHaveAttribute('aria-expanded', 'false');

  await page.evaluate(() => {
    window.location.hash = '0211-1';
  });
  const olderVersion = page.getByRole('heading', { level: 2, name: '0.2.11', exact: true });
  await expect(olderVersion).toBeFocused();
  await expect(olderVersion).toHaveAttribute('id', '0211-1');
  await expect(page.getByRole('button', { name: 'Full notes for 0.2.11' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );

  await page.evaluate(() => {
    window.location.hash = '20-october-2025';
  });
  await expect(page.getByRole('heading', { level: 3, name: '20 October 2025' })).toBeFocused();
});
