import { expect, test } from '@playwright/test';

test('a signed-out reporter recovers a public issue receipt after a lost response', async ({
  page,
  browser,
}) => {
  await page.goto('/changelog');
  const dialog = page.getByRole('dialog', { name: 'Give feedback' });
  await page.getByRole('button', { name: 'Give feedback' }).click();
  const description = 'Synthetic steps for the public feedback browser rehearsal.';
  const summary = 'Lost feedback response rehearsal';
  await dialog.getByRole('textbox', { name: 'Summary' }).fill(summary);
  await dialog.getByRole('textbox', { name: 'Description' }).fill(description);
  await dialog.getByRole('button', { name: 'Review issue' }).press('Enter');
  await expect(dialog).toContainText(description);
  const post = dialog.getByRole('button', { name: 'Post public issue' });
  await expect(post).toBeEnabled();
  let requestId: string | undefined;
  await page.route(
    '**/api/feedback/public',
    async (route) => {
      requestId = route.request().postDataJSON().requestId;
      const created = await route.fetch();
      expect(created.status()).toBe(201);
      await route.abort('connectionreset');
    },
    { times: 1 },
  );

  await post.press('Enter');
  await expect(dialog.getByRole('alert')).toContainText('could not confirm');
  await expect(dialog).toContainText(description);
  const retried = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/feedback/public') && response.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Retry report' }).press('Enter');
  const response = await retried;
  expect(response.status()).toBe(200);
  expect(requestId).toBeTruthy();
  expect(response.request().postDataJSON().requestId).toBe(requestId);
  await expect(dialog.getByRole('status')).toContainText('Feedback posted publicly');
  await expect(dialog.getByRole('link', { name: 'View issue #123 (new tab)' })).toHaveAttribute(
    'href',
    'https://github.com/ashleylamont/smashclub-seeding/issues/123',
  );
  expect((await page.request.get('/api/trpc/admin.feedbackInbox')).status()).toBe(401);
  expect((await page.request.post('/api/feedback', { data: { summary } })).status()).toBe(410);

  const maintainer = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const signIn = await maintainer.request.post('/api/auth/sign-in/email', {
      data: { email: 'admin@smashclub.dev', password: 'devpassword123' },
    });
    expect(signIn.ok()).toBe(true);
    const adminPage = await maintainer.newPage();
    await adminPage.goto('/admin/review');
    await adminPage.getByRole('link', { name: 'Past private feedback', exact: true }).click();
    await expect(adminPage.getByRole('heading', { name: 'Past private feedback' })).toBeVisible();
    await expect(adminPage.getByText('No reports on this page')).toBeVisible();
  } finally {
    await maintainer.close();
  }
});
