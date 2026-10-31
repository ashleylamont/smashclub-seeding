import { expect, test, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import type { PublicEventNight } from '../src/lib/publicEvents';
import { rpcProcedures } from '../test-support/rpcBatch';
import { ready } from './fixtures';

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
