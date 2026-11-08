import { expect, test, type Page } from '@playwright/test';
import type { MyClaim } from '../src/lib/apiTypes';
import { mockEvent } from './fixtures';

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
