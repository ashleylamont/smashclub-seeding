import { chooseOption } from '../test-support/controls';
import { test, expect, type APIRequestContext } from '@playwright/test';
import type { LeaderboardData, MyClaim, PlayerData } from '../src/lib/apiTypes';

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

async function profileRpc<T>(
  request: APIRequestContext,
  procedure: string,
  input?: object,
  mutate = false,
) {
  const path = `/api/trpc/${procedure}`;
  const response = mutate
    ? await request.post(path, { data: input })
    : await request.get(path, input ? { params: { input: JSON.stringify(input) } } : {});
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result.data as T;
}

for (const width of [390, 1440]) {
  test(`player claims a public profile and saves a main after approval at ${width}px`, async ({
    page,
    browser,
    baseURL,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: width === 390 ? 'light' : 'dark' });
    const adminContext = await browser.newContext({ baseURL });
    const admin = await adminContext.newPage();
    const alias = `Profile claim rehearsal ${width} with a long public alias`;
    let playerId: string | undefined;
    try {
      const login = await admin.request.post('/api/auth/sign-in/email', {
        data: { email: 'admin@smashclub.dev', password: 'devpassword123' },
      });
      expect(login.ok(), await login.text()).toBe(true);
      const created = await profileRpc<{ playerId: string }>(
        admin.request,
        'admin.createPlayer',
        {
          canonicalName: `Private Fixture Registry Name ${width}`,
          displayName: alias,
          companyCode: null,
          characters: [],
          aliases: [],
        },
        true,
      );
      playerId = created.playerId;
      const target = `/players/${playerId}`;
      await page.goto(target);
      await expect(page.getByRole('heading', { name: alias })).toBeVisible();
      await page.getByRole('link', { name: 'Sign in to claim this profile' }).click();
      await expect(page).toHaveURL(`/login?claim=${playerId}`);
      await chooseOption(page.getByLabel('Account', { exact: true }), {
        label: width === 390 ? 'Player (profile claim)' : 'Event organiser',
      });
      await page.getByRole('button', { name: 'Sign in to rehearsal' }).click();
      await expect(page).toHaveURL(`/me?claim=${playerId}`);
      await expect(page.getByRole('link', { name: alias })).toBeVisible();
      await page
        .getByRole('textbox', { name: 'Note for administrators (optional)' })
        .fill('Synthetic ownership evidence');
      await page.getByRole('button', { name: 'Request claim' }).click();
      const check = page.getByRole('button', { name: 'Check approval' });
      await expect(check).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Main characters' })).toHaveCount(0);
      const pendingWrite = await page.request.post('/api/trpc/me.updateCharacters', {
        data: { playerId, characters: ['fox'] },
      });
      expect((await pendingWrite.json()).error.data.code).toBe('FORBIDDEN');

      await admin.goto('/admin/players');
      const approve = admin
        .getByRole('row')
        .filter({ hasText: alias })
        .getByRole('button', { name: 'Approve', exact: true });
      await approve.click();
      await expect(approve).toHaveCount(0);
      await check.click();
      const edit = page.getByRole('link', { name: 'Edit main characters' });
      await expect(edit).toBeVisible();
      await edit.press('Enter');
      await expect(page.getByRole('heading', { name: 'Main characters' })).toBeFocused();
      await page.getByRole('textbox', { name: 'Filter characters' }).fill('fox');
      await page.getByRole('button', { name: 'Fox', exact: true }).click();
      await page.getByRole('button', { name: 'Save characters', exact: true }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();

      const leaderboard = await profileRpc<LeaderboardData>(admin.request, 'public.leaderboard');
      const unrelatedWrite = await page.request.post('/api/trpc/me.updateCharacters', {
        data: { playerId: leaderboard.rows[0]!.playerId, characters: ['fox'] },
      });
      expect((await unrelatedWrite.json()).error.data.code).toBe('FORBIDDEN');
      const publicProfile = await profileRpc<PlayerData>(admin.request, 'public.player', {
        playerId,
      });
      expect(publicProfile.player).toMatchObject({
        name: alias,
        verified: true,
        characters: ['fox'],
      });
      expect(publicProfile.player).not.toHaveProperty('canonicalName');
      await page.getByRole('link', { name: alias }).click();
      await expect(page.getByRole('img', { name: 'Mains Fox' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Edit your profile' })).toHaveAttribute(
        'href',
        `/me?claim=${playerId}#main-characters`,
      );
    } finally {
      if (playerId) {
        const response = await page.request.get('/api/trpc/me.claims', { timeout: 5000 });
        if (response.ok()) {
          const claims = (await response.json()).result.data as MyClaim[];
          const live = claims.find(
            (claim) =>
              claim.playerId === playerId && ['pending', 'approved'].includes(claim.status),
          );
          if (live) await profileRpc(page.request, 'me.withdrawClaim', { claimId: live.id }, true);
        }
      }
      await adminContext.close();
    }
  });
}
