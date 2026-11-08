import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { trpc } from '../src/lib/trpc';
import { bracketCaptureOptions, mockEvent, PLAN_ID, PLAYER_NAME, ready } from './fixtures';

const origin = 'https://nemesis-fixture.test';
const clockStart = new Date('2026-10-04T00:00:00Z');
const promotion = { channel: 'club_stream', expiresAt: '2026-10-04T00:10:00.000Z' };
type Request = Parameters<typeof trpc.eventOps.setTwitchPromotion.mutate>[0];

async function secureFixture(page: Page, baseURL: string) {
  const loopback = new URL(baseURL);
  if (loopback.protocol !== 'http:' || loopback.hostname !== '127.0.0.1')
    throw new Error('The secure fixture must use the local Vite server.');

  // Exercise the real HTTPS branch without TLS setup or external network traffic.
  await page.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) return route.fallback();
    const target = new URL(loopback);
    target.pathname = url.pathname;
    target.search = url.search;
    // Playwright retries ECONNRESET only. Keep the retry on the read-only loopback hop.
    const response = await route.fetch({
      url: target.href,
      maxRedirects: 0,
      maxRetries: request.method() === 'GET' ? 1 : 0,
    });
    await route.fulfill({ response });
  });
}

async function assertAccessible(page: Page) {
  await ready(page);
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
}

for (const theme of ['dark', 'light'] as const) {
  for (const width of [390, 1440]) {
    test(`event Twitch promotion fits ${width}px in ${theme} mode`, async ({
      page,
      baseURL,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      await secureFixture(page, baseURL!);
      const fixture = await mockEvent(page, { bracket: true });
      await page.clock.install({ time: clockStart });
      fixture.responses['eventOps.snapshot'] = { ...fixture.snapshot, twitchPromotion: promotion };
      const requests: { url: string; referrer?: string }[] = [];
      await page.route('https://player.twitch.tv/**', async (route) => {
        requests.push({ url: route.request().url(), referrer: route.request().headers().referer });
        await route.fulfill({
          contentType: 'text/html',
          body: '<html lang="en"><head><title>Twitch fixture</title></head><body><main>Stream fixture</main></body></html>',
        });
      });
      await page.goto(`${origin}/play/${PLAN_ID}?player=player-alex`);
      expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
      const stream = page.getByRole('region', { name: 'Twitch stream' });
      const direct = stream.getByRole('link', { name: 'Watch on Twitch' });
      const load = stream.getByRole('button', { name: 'Load Twitch player' });
      await expect(direct).toHaveAttribute('href', 'https://www.twitch.tv/club_stream');
      await expect(page.getByText(PLAYER_NAME, { exact: true }).first()).toBeVisible();
      await expect(page.locator('iframe')).toHaveCount(0);
      await assertAccessible(page);
      expect(requests).toEqual([]);

      if (width === 390) {
        await expect(load).toHaveCount(0);
      } else {
        await load.focus();
        await load.press('Enter');
        const player = page.locator('iframe[title="Twitch stream"]');
        await expect(player).toBeVisible();
        await expect(player).toHaveAttribute('sandbox', 'allow-same-origin allow-scripts');
        await expect.poll(() => requests.length).toBe(1);
        const playerUrl = new URL(requests[0]!.url);
        expect(playerUrl.searchParams.get('channel')).toBe('club_stream');
        expect(playerUrl.searchParams.get('parent')).toBe('nemesis-fixture.test');
        expect(playerUrl.searchParams.get('autoplay')).toBe('false');
        expect(requests[0]!.referrer).toBe(`${origin}/`);
        const bounds = await player.boundingBox();
        expect(bounds!.width).toBeGreaterThanOrEqual(400);
        expect(bounds!.height).toBeGreaterThanOrEqual(300);
        await expect(direct).toBeVisible();
        await assertAccessible(page);
      }
      await page.screenshot({ path: testInfo.outputPath('event-hub.png'), fullPage: true });
      await page.screenshot({ path: testInfo.outputPath('event-hub-viewport.png') });
      if (width === 1440 && theme === 'light') {
        await page.setViewportSize({ width: 425, height: 900 });
        await expect(page.locator('iframe')).toHaveCount(0);
        await expect(load).toHaveCount(0);
        await expect(direct).toBeVisible();
        await page.setViewportSize({ width, height: 900 });
        await expect(load).toBeVisible();
        expect(requests).toHaveLength(1);
        await load.click();
        await expect.poll(() => requests.length).toBe(2);
      }
      await page.clock.fastForward(10 * 60_000 + 1_001);
      await expect(stream).toHaveCount(0);
      await expect(page.locator('iframe')).toHaveCount(0);
      expect(fixture.unexpected).toEqual([]);
    });

    test(`Broadcast Twitch controls fit ${width}px in ${theme} mode`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      const fixture = await mockEvent(page, { role: 'player', bracket: true });
      let revision = 0;
      let current: Request['promotion'] = null;
      const requests: Request[] = [];
      const update = () => {
        fixture.responses['eventOps.overview'] = {
          ...fixture.overview,
          twitchBroadcast: { revision, promotion: current },
        };
      };
      update();
      await page.route('**/api/trpc/eventOps.setTwitchPromotion*', async (route) => {
        const batched = new URL(route.request().url()).searchParams.has('batch');
        const body = JSON.parse(route.request().postData() ?? '{}');
        const input = batched ? body[0] : body;
        requests.push(input);
        expect(input.expectedRevision).toBe(revision);
        current = input.promotion;
        revision++;
        update();
        const result = { result: { data: { promotion: current, revision } } };
        await route.fulfill({ json: batched ? [result] : result });
      });
      await page.goto(`/operate/${PLAN_ID}?view=broadcast`);
      const control = page.getByRole('region', { name: 'Public Twitch stream' });
      await expect(control.getByRole('heading')).toHaveText('Public Twitch stream');
      await expect(control).toContainText(
        'Republishing shows it again until it expires or you stop it.',
      );
      const channel = control.getByRole('textbox', { name: 'Twitch channel name or link' });
      const announce = control.getByRole('button', { name: 'Announce Twitch stream' });
      await expect(announce).toBeDisabled();
      await channel.fill('https://www.twitch.tv/Club_Stream');
      await announce.focus();
      await announce.press('Enter');
      await expect(control).toContainText('club_stream');
      await expect(control).toContainText('Shown to viewers');
      expect(requests).toMatchObject([
        { planId: PLAN_ID, expectedRevision: 0, promotion: { channel: 'club_stream' } },
      ]);
      expect(requests[0]!.promotion?.expiresAt).toBe('2026-10-04T04:00:00.000Z');
      await assertAccessible(page);
      await page.screenshot({
        path: testInfo.outputPath('broadcast.png'),
        fullPage: true,
        ...bracketCaptureOptions,
      });
      await control.screenshot({ path: testInfo.outputPath('broadcast-controls.png') });
      const stop = control.getByRole('button', { name: 'Stop Twitch announcement' });
      await stop.focus();
      await stop.press('Enter');
      await expect(stop).toHaveCount(0);
      expect(requests.at(-1)).toEqual({ planId: PLAN_ID, expectedRevision: 1, promotion: null });
      expect(fixture.unexpected).toEqual([]);
    });
  }
}

test('insecure event hub offers only the direct link and hides it when results close', async ({
  page,
}) => {
  const fixture = await mockEvent(page);
  fixture.responses['eventOps.snapshot'] = { ...fixture.snapshot, twitchPromotion: promotion };
  await page.goto(`/play/${PLAN_ID}`);
  await expect(page.getByRole('link', { name: 'Watch on Twitch' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load Twitch player' })).toHaveCount(0);
  fixture.responses['eventOps.snapshot'] = {
    ...fixture.snapshot,
    plan: { ...fixture.snapshot.plan, status: 'complete' },
    twitchPromotion: promotion,
  };
  await expect(page.getByRole('link', { name: 'Watch on Twitch' })).toHaveCount(0);
});

test('Broadcast keeps the exact request after a lost reply and refreshes after a definitive conflict', async ({
  page,
}) => {
  const fixture = await mockEvent(page, { role: 'player' });
  await page.clock.install({ time: clockStart });
  fixture.responses['eventOps.overview'] = {
    ...fixture.overview,
    twitchBroadcast: { revision: 0, promotion: null },
  };
  const requests: Request[] = [];
  await page.route('**/api/trpc/eventOps.setTwitchPromotion*', async (route) => {
    const batched = new URL(route.request().url()).searchParams.has('batch');
    const body = JSON.parse(route.request().postData() ?? '{}');
    const input = batched ? body[0] : body;
    requests.push(input);
    if (requests.length === 1) return route.abort();
    if (requests.length === 2) {
      fixture.responses['eventOps.overview'] = {
        ...fixture.overview,
        twitchBroadcast: { revision: 1, promotion: { ...promotion, channel: 'second_to' } },
      };
      const result = {
        error: {
          message: 'The Twitch announcement changed. Refresh it before saving.',
          code: -32009,
          data: { code: 'CONFLICT', httpStatus: 409 },
        },
      };
      return route.fulfill({ status: 409, json: batched ? [result] : result });
    }
    const result = { result: { data: { revision: 2, promotion: input.promotion } } };
    await route.fulfill({ json: batched ? [result] : result });
  });
  await page.goto(`/operate/${PLAN_ID}?view=broadcast`);
  const control = page.getByRole('region', { name: 'Public Twitch stream' });
  const announce = control.getByRole('button', { name: 'Announce Twitch stream' });
  const input = control.getByRole('textbox', { name: 'Twitch channel name or link' });
  await input.fill('club_stream');
  await announce.click();
  await expect.poll(() => requests.length).toBe(1);
  await expect(announce).toBeEnabled();
  await page.clock.fastForward(60_000);
  await announce.click();
  await expect(control).toContainText('second_to');
  expect(requests[1]).toEqual(requests[0]);
  await expect(input).toHaveValue('club_stream');
  await control.getByRole('button', { name: 'Update Twitch announcement' }).click();
  await expect.poll(() => requests.length).toBe(3);
  expect(requests[2]).toMatchObject({ expectedRevision: 1, promotion: { channel: 'club_stream' } });
  expect(requests[2]?.promotion?.expiresAt).not.toBe(requests[0]?.promotion?.expiresAt);
  expect(fixture.unexpected).toEqual([]);
});
