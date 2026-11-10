import { expect, test, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import type { MyClaim, PlayerData } from '../src/lib/apiTypes';
import { mockEvent, ready } from './fixtures';

const PLAYER_ID = '3048c081-1afa-4eab-a0a0-622853293ae2';
const OTHER_ID = 'afcc7fd0-e377-4832-9de0-18a3fa0c194a';

function playerClaim(playerId: string, status: MyClaim['status'], name: string): MyClaim {
  return {
    id: playerId,
    playerId,
    playerName: name,
    status,
    note: null,
    displayName: name,
    companyCode: 'ATL',
    defaultAlias: name,
    characters: ['fox'],
    createdAt: '2026-10-04T00:00:00Z',
    resolvedAt: null,
  };
}

async function mockAccount(page: Page, initial: string | null) {
  let account = initial;
  const fixture = await mockEvent(page);
  await page.route('**/api/auth/get-session', async (route) => {
    await route.fulfill({
      json: account
        ? {
            user: {
              id: account,
              name: account,
              email: `${account}@example.test`,
              emailVerified: true,
              image: null,
              createdAt: '2026-10-04T00:00:00Z',
              updatedAt: '2026-10-04T00:00:00Z',
            },
            session: {
              id: account,
              userId: account,
              expiresAt: '2027-01-01T00:00:00Z',
              token: 'fixture-auth',
            },
          }
        : null,
    });
  });
  await page.route('**/api/auth/list-accounts', (route) =>
    route.fulfill({ json: account === 'Account A' ? [{ providerId: 'discord' }] : [] }),
  );
  await page.route('**/api/auth-options', (route) =>
    route.fulfill({ json: { credentials: false, providers: ['discord'] } }),
  );
  let ticks = 0;
  return {
    ...fixture,
    async switchTo(user: string | null) {
      account = user;
      ticks += 10_000;
      await page.clock.setFixedTime(new Date(Date.parse('2026-10-04T00:00:00Z') + ticks));
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    },
  };
}

test('keeps a former account claim, provider state and editor draft private during a same-tab account switch', async ({
  page,
}) => {
  const fixture = await mockAccount(page, 'Account A');
  const old = {
    ...playerClaim(PLAYER_ID, 'approved', 'Private account A profile'),
    note: 'Private account A note',
  };
  fixture.responses['me.claims'] = [old];
  await page.goto('/me');
  await expect(page.getByText(old.note, { exact: false })).toBeVisible();
  await expect(page.getByText('✓ Discord linked')).toBeVisible();
  await page.getByLabel('Public alias', { exact: true }).fill('Unsaved account A draft');

  let release!: () => void;
  const pendingClaims = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/trpc/**', async (route) => {
    if (decodeURIComponent(new URL(route.request().url()).pathname).includes('me.claims'))
      await pendingClaims;
    await route.fallback();
  });
  const next = playerClaim(OTHER_ID, 'approved', 'Account B player');
  fixture.responses['me.claims'] = [next];
  await fixture.switchTo('Account B');
  try {
    await expect(page.getByRole('link', { name: 'Account B', exact: true })).toBeVisible();
    await expect(page.getByText(old.note, { exact: false })).toHaveCount(0);
    await expect(page.getByText('✓ Discord linked')).toHaveCount(0);
    await expect(page.getByLabel('Public alias', { exact: true })).toHaveCount(0);
  } finally {
    release();
  }
  await expect(page.getByRole('link', { name: next.playerName })).toBeVisible();
  await expect(page.getByLabel('Public alias', { exact: true })).toHaveValue(next.displayName!);
  await expect(page.getByRole('button', { name: 'Link Discord', exact: true })).toBeVisible();
  await fixture.switchTo(null);
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByText(next.playerName)).toHaveCount(0);
  expect(fixture.unexpected).toEqual([]);
});

const PUBLIC_NAME = 'Returning player with an exceptionally long tournament alias';

function publicPlayer(id = PLAYER_ID, verified = false): PlayerData {
  return {
    player: {
      id,
      name: id === PLAYER_ID ? PUBLIC_NAME : 'Other player',
      companyCode: 'ATL',
      companyName: 'Smash Club',
      verified,
      characters: verified ? ['fox'] : [],
    },
    rating: null,
    nights: [],
    events: [],
    recomputeId: null,
    model: 'whr',
    ratingScope: 'night',
    doublesResults: [],
    doublesMatches: [],
  };
}

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440]) {
    test(`${theme} ${width}px discovers a claim from the player page and reaches the approved editor`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      const fixture = await mockAccount(page, null);
      const optIn = (theme === 'dark' && width === 390) || (theme === 'light' && width === 1440);
      fixture.responses['me.whoami'] = {
        id: 'Claiming account',
        name: 'Claiming account',
        email: 'claimant@example.test',
        role: 'player',
        claimReviewMode: optIn ? (theme === 'dark' ? 'auto' : 'triage') : 'off',
      };
      let verified = false;
      fixture.queryResponses.set('public.player', (input) => {
        expect(input).toEqual({ playerId: PLAYER_ID });
        return publicPlayer(PLAYER_ID, verified);
      });
      const requests: unknown[] = [];
      await page.route('**/api/trpc/me.requestClaim*', async (route) => {
        const batched = new URL(route.request().url()).searchParams.has('batch');
        const body = route.request().postDataJSON();
        requests.push(batched ? body[0] : body);
        fixture.responses['me.claims'] = [playerClaim(PLAYER_ID, 'pending', PUBLIC_NAME)];
        const result = { result: { data: { claimId: PLAYER_ID } } };
        await route.fulfill({ json: batched ? [result] : result });
      });
      const inspect = async (name: string) => {
        await ready(page);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
        expect(
          (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
            .violations,
        ).toEqual([]);
        await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
      };

      await page.goto(`/players/${PLAYER_ID}`);
      const signIn = page.getByRole('link', { name: 'Sign in to claim this profile' });
      await expect(signIn).toHaveAttribute('href', `/login?claim=${PLAYER_ID}`);
      await inspect('01-public-profile');
      await signIn.press('Enter');
      await expect(page).toHaveURL(`/login?claim=${PLAYER_ID}`);
      await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
      await inspect('02-continue-sign-in');
      await fixture.switchTo('Claiming account');

      await expect(page).toHaveURL(`/me?claim=${PLAYER_ID}`);
      const request = page.getByRole('button', { name: 'Request claim' });
      await expect(request).toBeVisible();
      await expect(page.getByRole('link', { name: PUBLIC_NAME })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Search players' })).toHaveCount(0);
      expect(requests).toEqual([]);
      const review = page.getByRole('checkbox', { name: 'Allow automated review' });
      if (optIn) {
        await expect(review).not.toBeChecked();
        await expect(review).toHaveAccessibleDescription(
          /TypeSafe receives your account name and email/,
        );
      } else {
        await expect(review).toHaveCount(0);
      }
      await inspect('03-selected-player');
      await page
        .getByRole('textbox', { name: 'Note for administrators (optional)' })
        .fill('My bracket alias');
      if (optIn) {
        await review.press('Space');
        await expect(review).toBeChecked();
      }
      await request.press('Enter');

      const check = page.getByRole('button', { name: 'Check approval' });
      await expect(check).toBeVisible();
      expect(requests).toEqual([
        {
          playerId: PLAYER_ID,
          note: 'My bracket alias',
          ...(optIn ? { reviewWithJev: theme === 'dark' ? 'auto' : 'triage' } : {}),
        },
      ]);
      await expect(page.getByRole('heading', { name: 'Main characters' })).toHaveCount(0);
      await inspect('04-pending-approval');
      await page.getByRole('link', { name: PUBLIC_NAME }).click();
      await expect(page.getByRole('link', { name: 'View your claim status' })).toBeVisible();
      await page.getByRole('link', { name: 'View your claim status' }).click();

      verified = true;
      fixture.responses['me.claims'] = [playerClaim(PLAYER_ID, 'approved', PUBLIC_NAME)];
      await check.press('Enter');
      const edit = page.getByRole('link', { name: 'Edit main characters' });
      await expect(edit).toBeVisible();
      await inspect('05-approved-profile');
      await edit.press('Enter');
      const heading = page.getByRole('heading', { name: 'Main characters' });
      await expect(heading).toBeFocused();
      await expect(heading).toBeInViewport();
      await expect(page).toHaveURL(`/me?claim=${PLAYER_ID}#main-characters`);
      await expect(page.getByRole('textbox', { name: 'Filter characters' })).toBeVisible();
      await page.getByRole('link', { name: PUBLIC_NAME }).click();
      await page.getByRole('link', { name: 'Edit your profile' }).press('Enter');
      await expect(heading).toBeFocused();
      expect(fixture.unexpected).toEqual([]);
    });
  }

test('keeps exact verified ownership private and gives an unlinked signed-in player a direct claim path', async ({
  page,
}) => {
  const fixture = await mockAccount(page, 'Unlinked account');
  fixture.queryResponses.set('public.player', (input) => {
    const { playerId } = input as { playerId: string };
    return publicPlayer(playerId, playerId === PLAYER_ID);
  });

  await page.goto(`/players/${PLAYER_ID}`);
  await expect(page.getByRole('heading', { name: new RegExp(PUBLIC_NAME) })).toBeVisible();
  await expect(
    page.getByRole('link', { name: /edit your profile|claim this profile/i }),
  ).toHaveCount(0);

  await page.goto(`/me?claim=${PLAYER_ID}`);
  await expect(page.getByText('This profile is already linked.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Request claim' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Search players' })).toBeVisible();

  await page.goto(`/players/${OTHER_ID}`);
  const claim = page.getByRole('link', { name: 'Claim this profile', exact: true });
  await expect(claim).toHaveAttribute('href', `/me?claim=${OTHER_ID}`);
  await claim.click();
  await expect(page.getByRole('link', { name: 'Other player' })).toBeVisible();

  await page.goto(`/players/${PLAYER_ID}`);
  fixture.responses['me.claims'] = [playerClaim(PLAYER_ID, 'approved', PUBLIC_NAME)];
  await fixture.switchTo('First approved account');
  await expect(page.getByRole('link', { name: 'Edit your profile' })).toBeVisible();
  await fixture.switchTo('Second approved account');
  await expect(
    page.getByRole('link', { name: 'Second approved account', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Edit your profile' })).toBeVisible();

  fixture.responses['me.claims'] = [playerClaim(OTHER_ID, 'approved', 'Other player')];
  await fixture.switchTo('Different linked player account');
  await expect(
    page.getByRole('link', { name: 'Different linked player account', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Edit your profile' })).toHaveCount(0);
  await page.goto(`/me?claim=${PLAYER_ID}#main-characters`);
  await expect(
    page.getByText('This account already has a claim for a different player.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Other player' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Request claim' })).toHaveCount(0);
  await expect(page.locator('#main-characters')).toHaveCount(0);
  expect(fixture.unexpected).toEqual([]);
});

test('OAuth continuation accepts only the player UUID and builds a fixed internal destination', async ({
  page,
}) => {
  const fixture = await mockAccount(page, null);
  const callbacks: string[] = [];
  await page.route('**/api/auth/sign-in/social', async (route) => {
    callbacks.push(route.request().postDataJSON().callbackURL);
    await route.fulfill({ json: { redirect: false } });
  });
  for (const [claim, expected] of [
    [PLAYER_ID.toUpperCase(), `/me?claim=${PLAYER_ID}`],
    [
      `${PLAYER_ID}
`,
      '/me',
    ],
    ['//outside.example/players', '/me'],
    [`["${PLAYER_ID}"]`, '/me'],
    [String.raw`\outside.example`, '/me'],
  ] as const) {
    await page.goto(`/login?claim=${encodeURIComponent(claim)}&returnTo=https://outside.example`);
    await page.getByRole('button', { name: 'Continue with Discord' }).click();
    await expect.poll(() => callbacks.at(-1)).toBe(expected);
  }
  expect(callbacks).toHaveLength(5);
  expect(fixture.unexpected).toEqual([]);
});

test('continues to a canonical public profile and handles unavailable or mismatched targets', async ({
  page,
}) => {
  const fixture = await mockAccount(page, null);
  const merged = '65dc61a8-c675-4eaf-86de-e7a3c1ab582e';
  const missing = '440b33c6-bc48-48cf-9db4-ab0a1973900e';
  fixture.queryResponses.set('public.player', (input) => {
    const { playerId } = input as { playerId: string };
    if (playerId === merged) return { redirectTo: PLAYER_ID };
    return playerId === missing ? null : publicPlayer(playerId);
  });
  await page.goto(`/players/${merged}`);
  await expect(page.getByRole('link', { name: 'Sign in to claim this profile' })).toHaveAttribute(
    'href',
    `/login?claim=${PLAYER_ID}`,
  );
  await expect(page).toHaveURL(`/players/${PLAYER_ID}`);

  await page.goto(`/me?claim=${missing}`);
  await expect(page).toHaveURL(`/login?claim=${missing}`);
  await fixture.switchTo('New unlinked account');
  await expect(
    page.getByText('The selected profile is unavailable.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Search players' })).toBeVisible();

  await fixture.switchTo(null);
  await expect(page).toHaveURL(`/login?claim=${missing}`);
  await page.goto(`/login?claim=${PLAYER_ID}&returnTo=https://outside.example`);
  fixture.responses['me.claims'] = [playerClaim(OTHER_ID, 'pending', 'Other player')];
  await fixture.switchTo('Account with a different pending claim');
  await expect(page).toHaveURL(`/me?claim=${PLAYER_ID}`);
  await expect(
    page.getByText('This account already has a claim for a different player.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Other player' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check approval' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Request claim' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Main characters' })).toHaveCount(0);
  expect(fixture.unexpected).toEqual([]);
});
