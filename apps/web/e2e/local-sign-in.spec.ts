import { chooseOption } from '../test-support/controls';
import { test, expect } from '@playwright/test';

for (const account of [
  'Administrator',
  'Player (profile claim)',
  'Event player',
  'Event organiser',
]) {
  test(`signs in as ${account} through the rehearsal UI`, async ({ page }) => {
    if (account === 'Event player') await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Local rehearsal' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toHaveCount(0);
    await chooseOption(page.getByLabel('Account', { exact: true }), { label: account });
    await page.getByRole('button', { name: 'Sign in to rehearsal' }).click();
    await expect(page).toHaveURL(/\/me$/);
    await expect(page.locator('.me-account .account-name')).toBeVisible();
    await expect(page.locator('.app-nav .nav-link', { hasText: 'Admin' })).toHaveCount(
      account === 'Administrator' ? 1 : 0,
    );
    await page.reload();
    await expect(page.locator('.me-account .account-name')).toBeVisible();
  });
}

test('shows a failed password and lets the user retry', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Password', { exact: true }).fill('incorrect-password');
  await page.getByRole('button', { name: 'Sign in to rehearsal' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByLabel('Password', { exact: true }).fill('devpassword123');
  await page.getByRole('button', { name: 'Sign in to rehearsal' }).click();
  await expect(page).toHaveURL(/\/me$/);
});

test('hides rehearsal credentials when the API only enables OAuth', async ({ page }) => {
  await page.route('**/api/auth-options', (route) =>
    route.fulfill({
      json: { credentials: false, providers: ['google'] },
    }),
  );
  await page.goto('/login');
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Local rehearsal' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Continue with Discord' })).toHaveCount(0);
});

test('accepts credential requests with the Vite development origin', async ({ request }) => {
  const response = await request.post('/api/auth/sign-in/email', {
    headers: { Origin: 'http://127.0.0.1:5173' },
    data: { email: 'admin@smashclub.dev', password: 'devpassword123' },
  });
  expect(response.ok(), await response.text()).toBe(true);
});

test('recovers when sign-in options fail to load', async ({ page }) => {
  let attempts = 0;
  await page.route('**/api/auth-options', (route) => {
    attempts += 1;
    return attempts === 1
      ? route.fulfill({ status: 503, json: { error: 'unavailable' } })
      : route.fulfill({ json: { credentials: true, providers: [] } });
  });
  await page.goto('/login');
  await expect(page.getByRole('alert')).toContainText('temporarily unavailable');
  await page.getByRole('button', { name: 'Retry sign-in options' }).click();
  await expect(page.getByRole('heading', { name: 'Local rehearsal' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
