import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mockEvent, PLAN_ID, ready } from './fixtures';

async function inspect(page: Page, testInfo: TestInfo, state: string) {
  await ready(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    page.viewportSize()!.width,
  );
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath(`${state}.png`) });
}

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440]) {
    test(`${theme} ${width}px returns from provider sign-in and explains denied event access`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      const fixture = await mockEvent(page);
      const station = fixture.overview.stations[1]!;
      const path = `/operate/${PLAN_ID}?view=broadcast&station=${station.id}`;
      const login = `/login?operate=${PLAN_ID}&view=broadcast&station=${station.id}`;
      let signedIn = false;
      let allowed = true;
      let overviewRequests = 0;
      await page.route('**/api/auth/get-session', (route) =>
        route.fulfill({
          json: signedIn
            ? {
                user: { id: 'example-user', name: 'Alex', email: 'alex@example.test' },
                session: { id: 'fixture-session', userId: 'example-user' },
              }
            : null,
        }),
      );
      await page.route('**/api/auth-options', (route) =>
        route.fulfill({ json: { credentials: false, providers: ['discord', 'google'] } }),
      );
      const provider = width === 390 ? 'Discord' : 'Google';
      await page.route('**/api/auth/sign-in/social', async (route) => {
        expect(route.request().postDataJSON()).toMatchObject({
          provider: provider.toLowerCase(),
          callbackURL: path,
        });
        signedIn = true;
        // Stand in for the provider round trip after asserting the API callback.
        await route.fulfill({ json: { redirect: true, url: path } });
      });
      await page.route('**/api/trpc/**', async (route) => {
        const url = new URL(route.request().url());
        const procedures = decodeURIComponent(url.pathname.replace('/api/trpc/', '')).split(',');
        if (procedures.includes('eventOps.overview')) {
          overviewRequests++;
          if (!signedIn || !allowed) {
            const result = procedures.map((procedure) =>
              procedure === 'eventOps.overview'
                ? {
                    error: {
                      message: 'Fixture access error',
                      code: signedIn ? -32003 : -32001,
                      data: { code: signedIn ? 'FORBIDDEN' : 'UNAUTHORIZED' },
                    },
                  }
                : { result: { data: fixture.responses[procedure] } },
            );
            return route.fulfill({ json: url.searchParams.has('batch') ? result : result[0] });
          }
        }
        await route.fallback();
      });

      await page.goto(
        `${path}&operate=3048c081-1afa-4eab-a0a0-622853293ae2&token=fixture-invite&returnTo=/me#fixture-fragment`,
      );
      const signIn = page.getByRole('main').getByRole('link', { name: 'Sign in to event control' });
      await expect(signIn).toHaveAttribute('href', login);
      await expect(page.locator('.app-nav').getByRole('link', { name: 'Sign in' })).toHaveAttribute(
        'href',
        login,
      );
      await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
      expect(overviewRequests).toBe(0);
      await signIn.focus();
      await expect(signIn).toBeFocused();
      await inspect(page, testInfo, '01-signed-out');
      await signIn.press('Enter');
      await expect(page).toHaveURL(login);
      await expect(page.getByText('Use the account assigned to this event.')).toBeVisible();
      const continueWithProvider = page.getByRole('button', { name: `Continue with ${provider}` });
      await expect(continueWithProvider).toBeVisible();
      await inspect(page, testInfo, '02-provider-sign-in');
      await continueWithProvider.click();
      await expect(page).toHaveURL(path);
      await expect(page.getByRole('tab', { name: 'Broadcast' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(page.getByRole('heading', { name: fixture.overview.plan.name })).toBeVisible();
      await expect(page.getByRole('combobox', { name: 'Station' })).toContainText(station.name);
      await inspect(page, testInfo, '03-assigned-event');

      allowed = false;
      await expect(page.getByRole('heading', { name: 'Event access denied' })).toBeVisible();
      await expect(page.getByRole('heading', { name: fixture.overview.plan.name })).toHaveCount(0);
      await expect(page.getByRole('tab', { name: 'Broadcast' })).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'Sign in to event control' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
      await inspect(page, testInfo, '04-access-denied');
      expect(fixture.unexpected).toEqual([]);
    });
  }

test('offers retry after a connection failure while loading an assigned event', async ({
  page,
}) => {
  const fixture = await mockEvent(page, { role: 'player' });
  let interrupted = true;
  await page.route('**/api/trpc/**', (route) => {
    const { pathname } = new URL(route.request().url());
    return interrupted && decodeURIComponent(pathname).includes('eventOps.overview')
      ? route.abort('connectionfailed')
      : route.fallback();
  });

  await page.goto(`/operate/${PLAN_ID}`);
  await expect(page.getByRole('heading', { name: 'Could not open event' })).toBeVisible();
  const retry = page.getByRole('button', { name: 'Try again' });
  await expect(retry).toBeEnabled();
  await expect(page.getByRole('link', { name: 'Sign in to event control' })).toHaveCount(0);
  interrupted = false;
  await retry.press('Enter');
  await expect(page.getByRole('heading', { name: fixture.overview.plan.name })).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
});
