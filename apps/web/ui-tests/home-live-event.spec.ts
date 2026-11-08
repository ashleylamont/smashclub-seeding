import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import type { PublicEventNight } from '../src/lib/publicEvents';
import { rpcProcedures } from '../test-support/rpcBatch';
import { mockEvent, PLAN_ID, ready } from './fixtures';
import { footerMetadataCaptureStyle } from './captureStyles';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const markdown = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const buildSha = process.env.VITE_BUILD_SHA?.trim();
const NOW = new Date('2026-10-31T09:00:00Z');
function event(id: string, competitionFormat: 'singles' | 'doubles'): PublicEventNight {
  return {
    id,
    name: 'Nemesis · The last club night of October with a very long tournament name',
    eventDate: '2026-10-31T08:00:00Z',
    status: 'underway',
    bracketMode: 'native',
    competitionFormat,
    drawPaused: false,
  };
}
async function mockHome(page: Page) {
  const fixture = { events: [] as PublicEventNight[], fail: false, hold: Promise.resolve() };
  await page.clock.install({ time: NOW });
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/api/auth/')) return route.fulfill({ json: null });
    if (url.endsWith('/api/live'))
      return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
    const procedures = rpcProcedures(url);
    if (procedures.includes('eventOps.publicEvents')) await fixture.hold;
    const responses: Record<string, unknown> = {
      'public.leaderboard': {
        rows: [],
        eventCount: 0,
        computedAt: null,
        model: 'test',
        activityPolicy: { graceEvents: 1, penaltyPerEvent: 10, penaltyCap: 100 },
      },
      'public.ratingHistory': { players: [], events: [] },
      'public.tournaments': [],
      'eventOps.publicEvents': fixture.events,
    };
    const results = procedures.map((procedure) => {
      expect(procedure in responses, `Unexpected API procedure ${procedure}`).toBe(true);
      return procedure === 'eventOps.publicEvents' && fixture.fail
        ? {
            error: {
              message: 'Offline',
              code: -32603,
              data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
            },
          }
        : { result: { data: responses[procedure] } };
    });
    await route.fulfill({ json: new URL(url).searchParams.has('batch') ? results : results[0] });
  });
  return fixture;
}

test('home handles discovery loading and keeps rankings accessible after refresh failures', async ({
  page,
}) => {
  const fixture = await mockHome(page);
  let release!: () => void;
  fixture.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.goto('/');
  const entry = page.getByRole('region', { name: 'Currently live' });
  await expect(entry.getByRole('status')).toHaveText('Checking for live tournaments…');
  release();
  await expect(entry).toContainText('No tournament is live right now.');
  await expect(page.getByRole('heading', { name: 'Rankings', exact: true })).toBeVisible();
  fixture.events = [event('singles', 'singles')];
  await page.clock.fastForward(15_001);
  await expect(entry.getByRole('link', { name: 'Open live tournament' })).toBeVisible();
  fixture.fail = true;
  await page.clock.fastForward(15_001);
  await expect(entry.getByRole('alert')).toContainText('Live events could not be refreshed.');
  await expect(page.getByRole('heading', { name: 'Rankings', exact: true })).toBeVisible();
  await expect(entry.getByRole('link', { name: 'Open live tournament' })).toHaveCount(0);
  fixture.fail = false;
  fixture.events = [];
  await entry.getByRole('button', { name: 'Try again' }).click();
  await expect(entry).toContainText('No tournament is live right now.');
  await expect(entry.getByRole('link', { name: 'All events →' })).toHaveAttribute('href', '/play');
});

for (const theme of ['light', 'dark'] as const) {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    test(`home live choices fit ${viewport.width}px in ${theme} mode`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: theme });
      const fixture = await mockHome(page);
      fixture.events = [event('singles', 'singles'), event('doubles', 'doubles')];
      await page.goto('/');
      const entry = page.getByRole('region', { name: 'Currently live' });
      await expect(entry).toContainText('2 live tournaments · choose yours.');
      const choices = entry.getByRole('link', { name: 'Open live tournament', exact: true });
      await expect(choices).toHaveCount(2);
      await expect(choices.nth(0)).toHaveAttribute('href', '/play/singles');
      await expect(choices.nth(1)).toHaveAttribute('href', '/play/doubles');
      await expect(entry.locator('li').nth(0)).toContainText('Singles');
      await expect(entry.locator('li').nth(1)).toContainText('Doubles');
      await choices.first().focus();
      await expect(choices.first()).toBeFocused();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true);
      const accessibility = await new AxeBuilder({ page })
        .include('.home-live')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze();
      expect(accessibility.violations).toEqual([]);
      await ready(page);
      await page.screenshot({
        path: testInfo.outputPath(`home-live-${viewport.width}-${theme}.png`),
        fullPage: true,
      });
      // The page clock also expires stale events without a navigation or API change.
      await page.clock.fastForward(24 * 60 * 60_000);
      await expect(entry).toContainText('No tournament is live right now.');
      await expect(choices).toHaveCount(0);
    });
  }
}

for (const theme of ['light', 'dark'] as const) {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    test(`Nemesis release history is readable at ${viewport.width}px in ${theme} mode`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: theme });
      await mockHome(page);
      const footer = page.getByRole('contentinfo');
      const link = footer.getByRole('link', { name: 'Changelog', exact: true });
      for (const route of ['/', '/tournaments']) {
        await page.goto(route);
        await expect(page.getByRole('main').getByRole('link', { name: 'Changelog' })).toHaveCount(
          0,
        );
        await expect(link).toHaveAttribute('href', '/changelog');
        await expect(footer).toContainText(`v${version} · build ${buildSha?.slice(0, 7) || 'dev'}`);
        if (buildSha)
          await expect(footer.getByRole('link', { name: buildSha.slice(0, 7) })).toHaveAttribute(
            'href',
            `https://github.com/ashleylamont/smashclub-seeding/commit/${buildSha}`,
          );
      }
      await link.focus();
      await expect(link).toBeFocused();
      await footer.screenshot({ path: testInfo.outputPath('footer.png') });
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL('/changelog');
      const main = page.getByRole('main');
      await expect(
        main.getByRole('heading', { level: 1, name: 'Nemesis changelog' }),
      ).toBeVisible();
      await expect(
        main.getByRole('heading', { level: 2, name: version, exact: true }),
      ).toBeVisible();
      await expect(main.getByRole('heading', { level: 3, name: '20 October 2025' })).toBeVisible();
      await expect(
        main.getByRole('heading', { level: 2, name: 'Before versioned releases' }),
      ).toHaveClass('changelog-archive');
      for (const tier of ['Major Changes', 'Minor Changes', 'Patch Changes']) {
        for (const heading of await main
          .getByRole('heading', { level: 3, name: tier, exact: true })
          .all())
          await expect(heading).toHaveClass('changelog-release-tier');
      }
      await expect(
        main
          .getByRole('listitem')
          .filter({ hasText: 'OBS connection-interruption check' })
          .locator('.changelog-category'),
      ).toHaveText('Maintenance');
      const categories = ['Milestone', 'Feature', 'Improvement', 'Fix', 'Maintenance'];
      for (const category of categories) {
        const annotations = [
          ...markdown.matchAll(
            new RegExp(`^- (?:\\d{1,2} [A-Za-z]+ \\d{4} · )?\\*\\*${category}\\*\\* · `, 'gm'),
          ),
        ].length;
        expect(annotations).toBeGreaterThan(0);
        await expect(
          main.getByRole('listitem').locator(`.changelog-category-${category.toLowerCase()}`),
        ).toHaveCount(annotations);
      }
      await expect(main.getByRole('link', { name: '#151', exact: true })).toHaveAttribute(
        'href',
        'https://github.com/ashleylamont/smashclub-seeding/pull/151',
      );
      await expect(main.getByRole('link', { name: version, exact: true })).toHaveAttribute(
        'href',
        `https://github.com/ashleylamont/smashclub-seeding/releases/tag/v${version}`,
      );
      await expect(main.getByRole('link', { name: 'build 6f20a0a', exact: true })).toHaveAttribute(
        'href',
        'https://github.com/ashleylamont/smashclub-seeding/commit/6f20a0adcd84e04b9a09f677c67ec406496d73c9',
      );
      await ready(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
      ).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath('changelog.png') });
      const image = page.getByRole('img', {
        name: /OBS intermission showing a double-elimination bracket/,
      });
      await image.scrollIntoViewIfNeeded();
      await expect
        .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
        .toBeGreaterThan(0);
      expect((await image.boundingBox())!.width).toBeLessThanOrEqual(viewport.width);
      const illustratedEntry = main.getByRole('listitem').filter({ has: image });
      await expect(illustratedEntry.locator('.changelog-category-feature')).toHaveText('Feature');
      await illustratedEntry.screenshot({
        path: testInfo.outputPath('changelog-illustration.png'),
      });
    });
  }
}

test('the standalone OBS display stays outside the shared app footer', async ({ page }) => {
  await mockEvent(page, { idle: true });
  await page.goto(`/overlay/${PLAN_ID}?presentation=progress`);
  await expect(page.getByRole('region', { name: 'Tournament progress' })).toBeVisible();
  await expect(page.locator('.app-footer')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Changelog' })).toHaveCount(0);
});

test('footer screenshot metadata stays fixed while the normal DOM shows the actual values', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockHome(page);
  await page.goto('/');
  const footer = page.getByRole('contentinfo');
  const versionLabel = footer.locator('.app-version');
  const buildLabel = footer.locator('.build-label');
  await expect(versionLabel).toHaveText(`v${version}`);
  await expect(buildLabel).toHaveText(buildSha?.slice(0, 7) || 'dev');
  await ready(page);
  const capture = { style: footerMetadataCaptureStyle };
  const original = await footer.screenshot(capture);

  await versionLabel.evaluate((element) => {
    element.textContent = 'v123.456.789';
  });
  await buildLabel.evaluate((element) => {
    element.textContent = '123abcd';
  });
  await expect(versionLabel).toHaveText('v123.456.789');
  await expect(buildLabel).toHaveText('123abcd');
  expect(await footer.screenshot(capture)).toEqual(original);
});
