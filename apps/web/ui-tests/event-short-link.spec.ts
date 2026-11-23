import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { rpcProcedures } from '../test-support/rpcBatch';
import { mockEvent, PLAN_ID, ready } from './fixtures';

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test(`${theme} ${width}px retries a short event link in the same document`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ colorScheme: theme });
      await page.addInitScript((theme) => localStorage.setItem('smashclub:theme', theme), theme);
      const { snapshot, responses, unexpected } = await mockEvent(page, { idle: true });
      responses['eventOps.resolvePublicCode'] = { planId: PLAN_ID };
      const isLookup = (url: string) => rpcProcedures(url).includes('eventOps.resolvePublicCode');
      const failFirstRetry = theme === 'dark' && width === 390;
      let lookups = 0;
      let releaseLookup!: () => void;
      const heldLookup = new Promise<void>((resolve) => {
        releaseLookup = resolve;
      });
      await page.route(
        (url) => isLookup(url.href),
        async (route) => {
          lookups++;
          if (lookups === 1) return route.abort();
          if (lookups === 2) {
            await heldLookup;
            if (failFirstRetry) return route.abort();
          }
          await route.fallback();
        },
      );
      if (failFirstRetry) {
        await page.goto('/changelog');
        await expect(page.getByRole('heading', { name: 'Nemesis changelog' })).toBeVisible();
      }
      await page.goto('/e/1000427?pool=upper%3A0#results');
      const alert = page.getByRole('alert');
      await expect(alert).toContainText('Could not open the event link.');
      const historyLength = await page.evaluate(() => history.length);
      const retry = page.getByRole('button', { name: 'Try again' });
      let documentRequests = 0;
      page.on('request', (request) => {
        if (request.isNavigationRequest()) documentRequests++;
      });
      try {
        await retry.focus();
        await expect(retry).toBeFocused();
        await ready(page);
        await page.screenshot({
          path: testInfo.outputPath('short-link-retry.png'),
          fullPage: true,
        });
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
        const firstRetryRequest = page.waitForRequest(
          (request) => request.isNavigationRequest() || isLookup(request.url()),
        );
        await page.keyboard.press('Enter');
        expect((await firstRetryRequest).isNavigationRequest()).toBe(false);
        await expect(page.getByRole('status').filter({ hasText: 'Opening event…' })).toBeVisible();
        await expect(retry).toBeFocused();
        await expect(retry).toBeDisabled();
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
        await page.screenshot({
          path: testInfo.outputPath('short-link-opening.png'),
          fullPage: true,
        });
        await page.keyboard.press('Enter');
        await page.keyboard.press('Space');
        expect(lookups).toBe(2);
      } finally {
        releaseLookup();
      }
      if (failFirstRetry) {
        await expect(alert).toContainText('Could not open the event link.');
        await expect(retry).toBeFocused();
        await page.keyboard.press('Space');
      }
      await expect(page).toHaveURL(
        (url) =>
          url.pathname === `/play/${PLAN_ID}` &&
          url.searchParams.get('pool') === 'upper:0' &&
          url.hash === '#results',
      );
      await expect(page.getByRole('heading', { name: snapshot.plan.name })).toBeVisible();
      expect(await page.evaluate(() => history.length)).toBe(historyLength);
      expect(lookups).toBe(failFirstRetry ? 3 : 2);
      expect(documentRequests).toBe(0);
      expect(unexpected).toEqual([]);
      await ready(page);
      await page.screenshot({
        path: testInfo.outputPath('short-link-recovered.png'),
        fullPage: true,
      });
      if (failFirstRetry) {
        await page.goBack();
        await expect(page).toHaveURL(/\/changelog$/);
        expect(lookups).toBe(3);
      }
    });

test('an unpublished event short link has no retry action', async ({ page }) => {
  await mockEvent(page);
  await page.route(
    (url) => rpcProcedures(url.href).includes('eventOps.resolvePublicCode'),
    (route) =>
      route.fulfill({
        status: 404,
        json: [
          {
            error: {
              message: 'Not found',
              code: -32004,
              data: { code: 'NOT_FOUND', httpStatus: 404 },
            },
          },
        ],
      }),
  );
  await page.goto('/e/1000427');
  await expect(page.getByRole('alert')).toHaveText(
    'This event is unavailable or has not been published.',
  );
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
});

for (const [code, status, trpcCode] of [
  ['FORBIDDEN', 403, -32003],
  ['NOT_FOUND', 404, -32004],
] as const)
  test(`a short event link retry becomes unavailable after ${status}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { snapshot } = await mockEvent(page);
    let lookups = 0;
    await page.route(
      (url) => rpcProcedures(url.href).includes('eventOps.resolvePublicCode'),
      (route) => {
        lookups++;
        if (lookups === 1) return route.abort();
        return route.fulfill({
          status,
          json: [{ error: { message: code, code: trpcCode, data: { code, httpStatus: status } } }],
        });
      },
    );
    let snapshotRequests = 0;
    page.on('request', (request) => {
      if (rpcProcedures(request.url()).includes('eventOps.snapshot')) snapshotRequests++;
    });
    await page.goto('/e/1000427?pool=upper%3A0#results');
    const alert = page.getByRole('alert');
    await expect(alert).toHaveText('Could not open the event link.');
    let documentRequests = 0;
    page.on('request', (request) => {
      if (request.isNavigationRequest()) documentRequests++;
    });
    const retry = page.getByRole('button', { name: 'Try again' });
    await retry.press('Enter');
    await expect(alert).toHaveText('This event is unavailable or has not been published.');
    await expect(retry).toHaveCount(0);
    await expect(page.getByRole('heading', { name: snapshot.plan.name })).toHaveCount(0);
    await expect(page).toHaveURL(/\/e\/1000427\?pool=upper%3A0#results$/);
    expect(lookups).toBe(2);
    expect(snapshotRequests).toBe(0);
    expect(documentRequests).toBe(0);
  });
