import { expect, test } from '@playwright/test';

test('a signed-out reporter recovers a lost response and an admin sees one private report', async ({
  page,
  browser,
}) => {
  await page.goto('/changelog');
  const dialog = page.getByRole('dialog', { name: 'Give feedback' });
  await page.getByRole('button', { name: 'Give feedback' }).click();
  const description = 'Synthetic steps for the private feedback browser rehearsal.';
  const summary = 'Lost feedback response rehearsal';
  await dialog.getByRole('textbox', { name: 'Summary' }).fill(summary);
  await dialog.getByRole('textbox', { name: 'Description' }).fill(description);
  const send = dialog.getByRole('button', { name: 'Send private feedback' });
  await page.route(
    '**/api/feedback',
    async (route) => {
      const persisted = await route.fetch();
      expect(persisted.status()).toBe(201);
      await route.abort('connectionreset');
    },
    { times: 1 },
  );

  await send.press('Enter');
  await expect(dialog.getByRole('alert')).toContainText('Try again');
  await expect(dialog.getByRole('textbox', { name: 'Description' })).toHaveValue(description);
  const retried = page.waitForResponse((response) => response.url().endsWith('/api/feedback'));
  await send.press('Enter');
  const response = await retried;
  expect(response.status()).toBe(200);
  const { reference } = await response.json();
  expect(reference).not.toBe(response.request().postDataJSON().requestId);
  await expect(dialog.getByRole('status')).toContainText(reference);
  expect((await page.request.get('/api/trpc/admin.feedbackInbox')).status()).toBe(401);

  const maintainer = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const signIn = await maintainer.request.post('/api/auth/sign-in/email', {
      data: { email: 'admin@smashclub.dev', password: 'devpassword123' },
    });
    expect(signIn.ok()).toBe(true);
    const adminPage = await maintainer.newPage();
    await adminPage.goto('/admin/review');
    await adminPage.getByRole('link', { name: 'Feedback inbox', exact: true }).click();
    await expect(adminPage.getByRole('heading', { name: 'Feedback inbox' })).toBeVisible();
    const report = adminPage.getByRole('article').filter({ hasText: summary });
    await expect(report).toHaveCount(1);
    await expect(report).toContainText(description);
    await expect(report).toContainText(reference);
  } finally {
    await maintainer.close();
  }
});
