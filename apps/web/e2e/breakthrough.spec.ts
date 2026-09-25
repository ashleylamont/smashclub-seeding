import { test, expect } from '@playwright/test';

test('TOs can inspect evidence, share criteria and refresh a live night', async ({ page }) => {
  const signIn = await page.request.post('/api/auth/sign-in/email', {
    data: { email: 'admin@smashclub.dev', password: 'devpassword123' },
  });
  expect(signIn.ok()).toBe(true);
  // The harness verifies its credential account after creation; the first
  // tRPC request reconciles the allowlisted role before the UI reads it.
  expect((await page.request.get('/api/trpc/admin.settings')).ok()).toBe(true);
  await page.goto('/admin/breakthroughs');
  await expect(page.getByRole('heading', { name: 'Breakthroughs', exact: true })).toBeVisible();
  const evidence = page.getByRole('region', { name: 'Breakthrough evidence' });
  await expect(evidence).toBeVisible();
  await expect(evidence.getByRole('status')).toContainText('played sets');
  await expect(page.getByText('In progress · provisional')).toBeVisible();

  await page.getByLabel('Minimum prior nights', { exact: true }).fill('0');
  await page.getByLabel('Small-sample adjustment', { exact: true }).fill('5');
  await page.reload();
  await expect(page.getByLabel('Minimum prior nights', { exact: true })).toHaveValue('0');
  await expect(page.getByLabel('Small-sample adjustment', { exact: true })).toHaveValue('5');
  await page.locator('.breakthrough-detail summary').first().click();
  await expect(page.getByText('Adjusted surplus without the strongest comparable set:').first()).toBeVisible();

  // The real endpoint is used; the subsequent response verifies polling keeps
  // running without navigation or a manual refresh.
  const automaticRefresh = page.waitForResponse((response) => response.url().includes('admin.breakthrough') && response.ok());
  await automaticRefresh;
  await expect(evidence).toBeVisible();
  await page.getByRole('button', { name: 'Reset criteria' }).click();
  await expect(page.getByLabel('Minimum prior nights', { exact: true })).toHaveValue('2');
  await expect(page.getByLabel('Small-sample adjustment', { exact: true })).toHaveValue('3');
  await page.screenshot({ path: '/tmp/breakthrough-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/breakthrough-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
