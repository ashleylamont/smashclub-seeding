import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { chooseOption } from '../test-support/controls';
import { mockEvent, PLAN_ID, PLAYER_NAME, ready } from './fixtures';

const route = `/play/${PLAN_ID}`;
const preferenceKey = `nemesis:player-filter:${PLAN_ID}`;

async function linkedPlayer(page: Page) {
  const fixture = await mockEvent(page, { role: 'player', bracket: true });
  const match = fixture.snapshot.matches.find((item) => item.status === 'playing')!;
  const claim = { status: 'approved', playerId: match.player1Id!, playerName: PLAYER_NAME };
  fixture.responses['me.claims'] = [claim];
  const filter = page.getByLabel('Show matches for');
  const profile = page.getByText('Your linked profile:', { exact: false });
  return { fixture, match, claim, filter, profile };
}

async function deferResponse(
  page: Page,
  url: string | ((url: URL) => boolean) = '**/api/auth/get-session',
) {
  let releaseAuth!: () => void;
  const authDelay = new Promise<void>((resolve) => {
    releaseAuth = resolve;
  });
  await page.route(url, async (route) => {
    await authDelay;
    await route.fallback();
  });
  return releaseAuth;
}

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test(`opens on the approved linked entrant at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const { fixture, match, claim, filter, profile } = await linkedPlayer(page);
      await page.goto(route);
      await expect(profile).toContainText(PLAYER_NAME);
      await expect(filter).toHaveAttribute('data-value', claim.playerId);
      await expect(page.getByText('Choose your name to find your matches.')).toHaveCount(0);
      await expect(
        page.getByText('Changing this filter does not change your reporting identity.'),
      ).toBeVisible();
      await expect(page.getByRole('heading', { name: `${PLAYER_NAME}’s matches` })).toBeVisible();
      await expect(page.getByRole('button', { name: 'View current match' })).toBeVisible();
      expect(await page.evaluate((key) => localStorage.getItem(key), preferenceKey)).toBeNull();
      await expect(page).toHaveURL(new RegExp(`${route}$`));
      const card = page.locator(`article[data-player-match-id="${match.id}"]`);
      await expect(card).toContainText(PLAYER_NAME);
      await expect(card.getByRole('button', { name: /Submit score/ })).toBeDisabled();
      await card.getByRole('spinbutton').first().fill('2');
      await expect(card.getByRole('button', { name: /Submit score/ })).toBeEnabled();
      await page.getByRole('button', { name: /Match filters/ }).press('Enter');
      await expect(page.getByLabel('Match view')).toHaveAttribute('data-value', 'mine');
      await page.getByRole('link', { name: 'Brackets', exact: true }).press('Enter');
      await page.getByRole('button', { name: 'Full draw & bracket standings' }).press('Enter');
      await expect(page.locator('.event-brackets')).toBeVisible();
      await ready(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(
        (
          await new AxeBuilder({ page })
            .include('.player-event-hub')
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      await page.evaluate(() => scrollTo(0, 0));
      await ready(page);
      await page.screenshot({ path: testInfo.outputPath('personal-hub.png'), fullPage: true });

      await filter.press('Enter');
      await page.keyboard.press('Home');
      await expect(page.getByRole('option', { name: 'Everyone' })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(filter).toBeFocused();
      await expect(filter).toHaveAttribute('data-value', '');
      await expect(card.getByRole('spinbutton').first()).toHaveValue('2');
      await page.reload();
      await expect(profile).toContainText(PLAYER_NAME);
      await expect(filter).toHaveAttribute('data-value', '');
      expect(fixture.submissions).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });

test('late account data leaves an explicit Everyone choice in place', async ({ page }) => {
  const { fixture, filter, profile } = await linkedPlayer(page);
  const releaseAuth = await deferResponse(page);
  try {
    await page.goto(route);
    await expect(filter).toHaveAttribute('data-value', '');
    await chooseOption(filter, '');
    await expect(page.getByLabel('Match view')).toHaveAttribute('data-value', 'matches');
  } finally {
    releaseAuth();
  }
  await expect(profile).toContainText(PLAYER_NAME);
  await expect(filter).toHaveAttribute('data-value', '');
  expect(fixture.unexpected).toEqual([]);
});

test('late account data preserves a pool selected while browsing', async ({ page }) => {
  const { fixture, filter, profile } = await linkedPlayer(page);
  const releaseAuth = await deferResponse(page);
  const pool = page.getByRole('combobox', { name: 'Your pool' });
  try {
    await page.goto(route);
    await expect(filter).toHaveAttribute('data-value', '');
    await chooseOption(pool, 'lower:0');
    await expect(page).toHaveURL(/pool=lower%3A0/);
  } finally {
    releaseAuth();
  }
  await expect(profile).toContainText(PLAYER_NAME);
  await expect(filter).toHaveAttribute('data-value', '');
  await expect(pool).toHaveAttribute('data-value', 'lower:0');
  expect(await page.evaluate((key) => localStorage.getItem(key), preferenceKey)).toBeNull();
  expect(fixture.unexpected).toEqual([]);
});

test('late account data preserves an in-progress match search', async ({ page }) => {
  const { fixture, filter, profile } = await linkedPlayer(page);
  const releaseAuth = await deferResponse(page);
  const search = page.getByRole('textbox', { name: 'Search matches' });
  try {
    await page.goto(route);
    await expect(filter).toHaveAttribute('data-value', '');
    await search.fill('Bowser');
  } finally {
    releaseAuth();
  }
  await expect(profile).toContainText(PLAYER_NAME);
  await expect(filter).toHaveAttribute('data-value', '');
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('Bowser');
  expect(fixture.unexpected).toEqual([]);
});

test('late claim data leaves an unrelated score draft visible and editable', async ({ page }) => {
  const { fixture, claim, filter, profile } = await linkedPlayer(page);
  const other = fixture.snapshot.matches.find(
    (match) =>
      match.status === 'ready' &&
      match.player1Id &&
      match.player2Id &&
      ![match.player1Id, match.player2Id].includes(claim.playerId),
  )!;
  other.status = 'playing';
  const releaseClaim = await deferResponse(page, (url) =>
    decodeURIComponent(url.pathname).replace('/api/trpc/', '').split(',').includes('me.claims'),
  );
  const card = page.locator(`article[data-player-match-id="${other.id}"]`);
  const score = card.getByRole('spinbutton').first();
  try {
    await page.goto(route);
    await expect(filter).toHaveAttribute('data-value', '');
    await expect(page.getByText('Reporting with your signed-in account.')).toBeVisible();
    await score.fill('2');
  } finally {
    releaseClaim();
  }
  await expect(profile).toContainText(PLAYER_NAME);
  await expect(filter).toHaveAttribute('data-value', '');
  await expect(score).toBeFocused();
  await expect(score).toHaveValue('2');
  expect(fixture.submissions).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test('a saved player and a printed player link both take precedence', async ({ page }) => {
  const { fixture, match, filter, profile } = await linkedPlayer(page);
  const saved = match.player2Id!;
  const printed = fixture.snapshot.matches.find(
    (item) => item.player1Id && ![match.player1Id, saved].includes(item.player1Id),
  )!.player1Id!;
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [preferenceKey, saved],
  );
  await page.goto(route);
  await expect(profile).toContainText(PLAYER_NAME);
  await expect(filter).toHaveAttribute('data-value', saved);
  await page.goto(`${route}?player=${printed}`);
  await expect(profile).toContainText(PLAYER_NAME);
  await expect(filter).toHaveAttribute('data-value', printed);
  await page.goto(`${route}?player=`);
  await expect(profile).toContainText(PLAYER_NAME);
  await expect(filter).toHaveAttribute('data-value', '');
  expect(fixture.unexpected).toEqual([]);
});

test('a printed pool and a guest pass retain event-wide browsing', async ({ page }) => {
  const { fixture, filter, profile } = await linkedPlayer(page);
  await page.goto(`${route}?pool=upper%3A0`);
  await expect(profile).toContainText(PLAYER_NAME);
  await expect(filter).toHaveAttribute('data-value', '');
  await expect(page.getByLabel('Your pool')).toHaveAttribute('data-value', 'upper:0');
  fixture.responses['eventOps.guests.redeem'] = {
    sessionToken: 'local-fixture-guest-pass'.repeat(2),
    expiresAt: null,
  };
  fixture.responses['eventOps.guests.matches'] = { ...fixture.snapshot, reports: [] };
  await page.goto(`${route}#token=local-fixture-guest-invitation`);
  await expect(
    page.getByText('Reporting with your venue guest pass.', { exact: true }),
  ).toBeVisible();
  await expect(filter).toHaveAttribute('data-value', '');
  await page.reload();
  await expect(profile).toContainText(PLAYER_NAME);
  await expect(
    page.getByText('Reporting with your venue guest pass.', { exact: true }),
  ).toBeVisible();
  await expect(filter).toHaveAttribute('data-value', '');
  expect(fixture.unexpected).toEqual([]);
});

test('a public archive link keeps event-wide records for a linked account', async ({ page }) => {
  const { fixture, filter, profile } = await linkedPlayer(page);
  fixture.snapshot.plan.status = 'complete';
  await page.goto(`${route}#event-archive`);
  await expect(profile).toContainText(PLAYER_NAME);
  await expect(filter).toHaveAttribute('data-value', '');
  await expect(page.getByText('Good games award', { exact: true })).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
});

test('an approved profile outside the draw leaves Everyone selected', async ({ page }) => {
  const { fixture, claim, filter, profile } = await linkedPlayer(page);
  claim.playerId = 'entrant-not-in-this-event';
  await page.goto(route);
  await expect(profile).toContainText(PLAYER_NAME);
  await expect(filter).toHaveAttribute('data-value', '');
  await expect(page.getByRole('heading', { name: 'Matches & results' })).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
});

test('an approved doubles member opens the recorded team’s matches', async ({ page }) => {
  const { fixture, match, claim, filter, profile } = await linkedPlayer(page);
  const teamId = 'fixture-team';
  const teamName = 'Alex and a partner with a long tournament alias';
  const entrant = fixture.snapshot.entrants.find((item) => item.id === claim.playerId)!;
  Object.assign(entrant, {
    id: teamId,
    name: teamName,
    memberPlayerIds: [claim.playerId, 'fixture-partner'],
  });
  Object.assign(match, { player1Id: teamId, player1Name: teamName });
  // Only the team is entered; its member's personal ID does not occur in the match list.
  fixture.snapshot.matches = [match];
  await page.goto(route);
  await expect(profile).toContainText(PLAYER_NAME);
  await expect(filter).toHaveAttribute('data-value', teamId);
  await expect(page.getByRole('heading', { name: `${teamName}’s matches` })).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
});
