import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { LeaderboardData, PlayerData } from '../src/lib/apiTypes';
import { chooseOption } from '../test-support/controls';
import { mockEvent, ready } from './fixtures';

const alex = {
  playerId: '00000000-0000-4000-8000-000000000011',
  name: 'Alex Café & Co with a very long tournament alias from Western Sydney',
  companyCode: 'SYD',
  rank: 2,
  clubRating: 1596,
  eventCount: 8,
};
const players = [
  {
    playerId: '00000000-0000-4000-8000-000000000010',
    name: 'Leading player Café & Co',
    companyCode: 'NTH',
    rank: 1,
    clubRating: 1710,
    eventCount: 4,
  },
  alex,
  {
    playerId: '00000000-0000-4000-8000-000000000012',
    name: 'Club newcomer Café & Co',
    companyCode: 'SYD',
    rank: 3,
    clubRating: 1494,
    eventCount: 1,
  },
];

async function openRankings(
  page: Page,
  activityPolicy: LeaderboardData['activityPolicy'] = {
    graceEvents: 1,
    penaltyPerEvent: 20,
    penaltyCap: 100,
  },
  { leadingPlayerMisses = 0, rankMovement = true } = {},
) {
  const fixture = await mockEvent(page);
  const requestedPlayers: string[] = [];
  const leaderboard: LeaderboardData = {
    computedAt: '2026-09-29T10:00:00Z',
    model: 'whr',
    eventCount: 8,
    rows: players.map((player) => ({
      ...player,
      previousRank: rankMovement ? player.rank + 1 : null,
      rankDelta: rankMovement ? 1 : null,
      league: 'Club',
      skillRating: player.clubRating,
      skillSd: 90,
      conservativeRating: player.clubRating - 180,
      activityPenalty: 0,
      nextMissPenalty: 20,
      missedEvents: player.rank === 1 ? leadingPlayerMisses : 0,
      attendanceStreak: 1,
      isProvisional: player.rank === 3,
      rating: player.clubRating,
      rd: 90,
      effectiveRd: 90,
      wins: 24,
      losses: 15,
      matchCount: 39,
      tournamentCount: player.eventCount,
      sampleConfidence: 0.48,
      rookieRatio: 0,
      lastPlayedDate: '2026-09-29T08:00:00Z',
      companyName: player.companyCode === 'SYD' ? 'Western Sydney' : 'North Sydney',
      verified: true,
      characters: ['mario', 'kirby'],
    })),
    activityPolicy,
  };
  fixture.responses['public.leaderboard'] = leaderboard;
  fixture.responses['public.player'] = {
    player: {
      id: alex.playerId,
      name: alex.name,
      companyCode: alex.companyCode,
      companyName: 'Western Sydney',
      verified: true,
      characters: ['mario', 'kirby'],
    },
    rating: null,
    events: [],
    nights: [],
    recomputeId: null,
    model: 'whr',
    ratingScope: 'night',
    doublesResults: [],
    doublesMatches: [],
  } satisfies PlayerData;
  fixture.responses['public.ratingHistory'] = { players: [], events: [] };
  fixture.responses['public.tournaments'] = [];
  fixture.responses['eventOps.publicEvents'] = [];
  fixture.queryResponses.set('public.playerPreview', (input) => {
    const { playerId } = input as { playerId: string };
    requestedPlayers.push(playerId);
    return {
      profile: {
        name: alex.name,
        characters: ['mario', 'kirby'],
        rating: { clubRating: alex.clubRating, wins: 24, losses: 15, isProvisional: false },
      },
      redirectTo: null,
    };
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Rankings' })).toBeVisible();
  return { requestedPlayers, unexpected: fixture.unexpected };
}

for (const width of [390, 1440]) {
  for (const theme of ['dark', 'light'] as const) {
    test(`rankings shows current standings without a prior comparison at ${width}px in ${theme}`, async ({
      page,
    }, info) => {
      await page.clock.setFixedTime(new Date('2026-10-01T12:00:00Z'));
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.emulateMedia({ colorScheme: theme });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const { unexpected } = await openRankings(page, undefined, { rankMovement: false });

      const row = page.getByRole('link', { name: /^Alex Café & Co.*rank 2.*no movement recorded/ });
      await expect(row).toBeVisible();
      await expect(row).toContainText('1596');
      await expect(page.getByText('Biggest climb', { exact: true })).toHaveCount(0);
      await expect(
        page.locator('.board-link .movement-up, .board-link .movement-down'),
      ).toHaveCount(0);

      const legend = page.getByRole('button', { name: 'How to read the board' });
      await legend.press('Enter');
      await expect(legend).toHaveAttribute('aria-expanded', 'true');
      await expect(legend).toBeFocused();
      await ready(page);
      await page.screenshot({ path: info.outputPath('no-rank-movement.png'), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
          .violations,
      ).toEqual([]);
      expect(unexpected).toEqual([]);
    });

    test(`rankings uses the configured attendance policy at ${width}px in ${theme}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.emulateMedia({ colorScheme: theme });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const { unexpected } = await openRankings(page, {
        graceEvents: 3,
        penaltyPerEvent: 15,
        penaltyCap: 75,
      });

      const help = page.getByRole('button', { name: 'Explain: How ranking works' });
      await help.press('Enter');
      const policy = page.getByRole('dialog', { name: 'How ranking works' });
      await expect(policy).toContainText(/(?:up to 3 club nights|first 3 missed club nights)/i);
      await expect(policy).toContainText(/15 points.*75/);
      await ready(page);
      await page.screenshot({ path: info.outputPath('ranking-policy.png'), fullPage: true });
      await page.keyboard.press('Escape');
      await expect(help).toBeFocused();

      const legend = page.getByRole('button', { name: 'How to read the board' });
      await legend.press('Enter');
      const boardKey = page.locator('.board-legend');
      await expect(legend).toHaveAttribute('aria-expanded', 'true');
      await expect(boardKey).not.toContainText('The first miss is free');
      await expect(boardKey).toContainText('How ranking works');
      await expect(page.getByRole('link', { name: /^Alex Café & Co/ })).toContainText('1596');
      await ready(page);
      await page.screenshot({ path: info.outputPath('expanded-board-key.png'), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
          .violations,
      ).toEqual([]);
      expect(unexpected).toEqual([]);
    });
  }
}

for (const { name, policy, expected } of [
  {
    name: 'the first miss is charged',
    policy: { graceEvents: 0, penaltyPerEvent: 25, penaltyCap: 90 },
    expected: /each missed club night costs 25 points.*90/i,
  },
  {
    name: 'one missed night is free',
    policy: { graceEvents: 1, penaltyPerEvent: 40, penaltyCap: 120 },
    expected: /first missed club night is free.*40 points.*120/i,
  },
  {
    name: 'the nightly charge is zero',
    policy: { graceEvents: 3, penaltyPerEvent: 0, penaltyCap: 75 },
    expected: /there is no attendance penalty/i,
  },
  {
    name: 'the cap is zero',
    policy: { graceEvents: 3, penaltyPerEvent: 15, penaltyCap: 0 },
    expected: /there is no attendance penalty/i,
  },
]) {
  test(`ranking help describes the active policy when ${name}`, async ({ page }) => {
    const { unexpected } = await openRankings(page, policy);
    await page.getByRole('button', { name: 'Explain: How ranking works' }).press('Enter');
    await expect(page.getByRole('dialog', { name: 'How ranking works' })).toContainText(expected);
    expect(unexpected).toEqual([]);
  });
}

test('the board shows no attendance deduction beyond the grace window when the cap is zero', async ({
  page,
}, info) => {
  const { unexpected } = await openRankings(
    page,
    { graceEvents: 3, penaltyPerEvent: 15, penaltyCap: 0 },
    { leadingPlayerMisses: 4 },
  );
  const missed = page
    .getByRole('link', { name: /^Leading player/ })
    .getByText('4 missed', { exact: true });
  await expect(missed).toBeVisible();
  await expect(missed).toHaveAttribute('title', /no attendance deduction/i);
  await expect(missed).not.toHaveAttribute('title', /inside the grace window/i);
  await ready(page);
  await page.screenshot({ path: info.outputPath('no-attendance-deduction.png'), fullPage: true });
  expect(unexpected).toEqual([]);
});

test('browser Back restores Rankings search, company and ascending event sort', async ({
  page,
}, info) => {
  const { requestedPlayers, unexpected } = await openRankings(page);
  const board = page.locator('.board');
  const rows = board.getByRole('listitem');
  const search = board.getByRole('searchbox', { name: 'Search' });
  const company = board.getByRole('combobox', { name: 'Company' });
  const rankSort = board.getByRole('button', { name: /^Sorted by rank, lowest first/ });
  const eventsAscending = board.getByRole('button', {
    name: /^Sorted by events attended, lowest first/,
  });
  await expect(rankSort).toBeVisible();
  await expect(rows.first()).toContainText('Leading player');

  const entryState = await page.evaluate(() => window.history.state);
  const rapidEdit = 'x'.repeat(120);
  await search.pressSequentially(rapidEdit);
  await expect(search).toHaveValue(rapidEdit);
  expect(await page.evaluate(() => window.history.state)).toEqual(entryState);
  await search.fill('Café & Co');
  await expect(rows).toHaveCount(3);
  await chooseOption(company, 'SYD');
  await expect(rows).toHaveCount(2);
  await board.getByRole('button', { name: 'Sort by events attended' }).press('Enter');
  await expect(rows.first()).toContainText(alex.name);
  const directLink = rows.getByRole('link', { name: /^Alex Café & Co/ });
  await expect(directLink).toHaveAttribute('href', `/players/${alex.playerId}`);
  await board
    .getByRole('button', { name: /^Sorted by events attended, highest first/ })
    .press('Enter');
  await directLink.press('Enter');
  await expect(page).toHaveURL(`/players/${alex.playerId}`);
  await expect(page.getByRole('heading', { level: 1, name: /^Alex Café & Co/ })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL('/');
  await expect(search).toHaveValue('Café & Co');
  await expect(company).toHaveAttribute('data-value', 'SYD');
  await expect(eventsAscending).toBeVisible();
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('Club newcomer');
  await expect(rows.last()).toContainText(alex.name);
  await ready(page);
  await page.screenshot({ path: info.outputPath('rankings-after-back.png'), fullPage: true });

  await search.fill('Café & Co with');
  await directLink.click();
  await expect(page.getByRole('heading', { level: 1, name: /^Alex Café & Co/ })).toBeVisible();
  await page.goBack();
  await expect(search).toHaveValue('Café & Co with');
  await expect(rows).toHaveCount(1);
  await expect(eventsAscending).toBeVisible();

  await directLink.click();
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(search).toHaveValue('');
  await expect(company).toHaveAttribute('data-value', 'all');
  await expect(rankSort).toBeVisible();
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText('Leading player');
  expect(requestedPlayers).toEqual([]);
  expect(unexpected).toEqual([]);
});

for (const width of [721, 1440]) {
  for (const theme of ['dark', 'light'] as const) {
    test(`rankings gives the full row to the profile link at ${width}px in ${theme}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      const { requestedPlayers, unexpected } = await openRankings(page);
      const board = page.locator('.board');
      const rows = board.getByRole('listitem');
      const row = rows.nth(1);
      const directLink = row.getByRole('link', { name: /^Alex Café & Co/ });
      await expect(directLink.getByRole('img', { name: 'Mains Mario' })).toBeVisible();
      await expect(board.getByRole('button', { name: /^Preview / })).toHaveCount(0);
      await directLink.focus();
      await page.keyboard.press('Tab');
      await expect(rows.last().getByRole('link')).toBeFocused();
      expect(await directLink.evaluate((element) => element.getBoundingClientRect().right)).toBe(
        await row.evaluate((element) => element.getBoundingClientRect().right),
      );
      expect(requestedPlayers).toEqual([]);
      await page.evaluate(() => window.scrollTo(0, 0));
      await ready(page);
      await page.screenshot({ path: info.outputPath('rankings.png'), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
          .violations,
      ).toEqual([]);
      expect(unexpected).toEqual([]);
    });
  }
}

for (const width of [390, 720]) {
  test.describe(`${width}px player rankings`, () => {
    test.use({ hasTouch: width === 390 });

    for (const theme of ['dark', 'light'] as const) {
      test(`opens a player preview without leaving the ranked board in ${theme}`, async ({
        page,
      }, info) => {
        await page.setViewportSize({ width, height: 844 });
        await page.emulateMedia({ colorScheme: theme });
        const { requestedPlayers, unexpected } = await openRankings(page);
        const board = page.locator('.board');
        const rows = board.getByRole('listitem');
        await expect(rows).toHaveCount(3);
        await expect(rows.first()).toContainText('Leading player');
        await ready(page);
        await page.screenshot({ path: info.outputPath('rankings.png'), fullPage: true });

        await chooseOption(board.getByRole('combobox', { name: 'Sort' }), 'eventCount');
        await expect(rows.first()).toContainText(alex.name);
        const search = board.getByRole('searchbox', { name: 'Search' });
        await search.fill('Café & Co');
        await chooseOption(board.getByRole('combobox', { name: 'Company' }), 'SYD');
        await expect(rows).toHaveCount(2);

        const directLink = rows.first().getByRole('link', { name: /^Alex Café & Co/ });
        await expect(directLink).toHaveAttribute('href', `/players/${alex.playerId}`);
        await expect(directLink.getByRole('img', { name: 'Mains Mario' })).toBeHidden();
        const preview = rows.first().getByRole('button', { name: `Preview ${alex.name}` });
        expect(requestedPlayers).toEqual([]);
        await directLink.focus();
        await page.keyboard.press('Tab');
        await expect(preview).toBeFocused();
        if (width === 390) await preview.tap();
        else await page.keyboard.press('Enter');

        const dialog = page.getByRole('dialog', { name: alex.name });
        await expect(dialog.getByText('1596', { exact: true })).toBeVisible();
        await expect(dialog.getByText('24–15', { exact: true })).toBeVisible();
        await expect(dialog.getByText('Rated sets (W–L)')).toBeVisible();
        await expect(dialog.getByRole('img', { name: 'Mains Mario' })).toBeVisible();
        await expect(dialog.getByRole('link', { name: 'View full profile' })).toHaveAttribute(
          'href',
          `/players/${alex.playerId}`,
        );
        expect(requestedPlayers).toEqual([alex.playerId]);
        await ready(page);
        await page.screenshot({ path: info.outputPath('rankings-preview.png') });
        expect(
          (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
            .violations,
        ).toEqual([]);

        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
        await expect(preview).toBeFocused();
        await expect(search).toHaveValue('Café & Co');
        await expect(rows).toHaveCount(2);
        await expect(rows.first()).toContainText(alex.name);
        await expect(page).toHaveURL('/');
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
        expect(unexpected).toEqual([]);
      });
    }
  });
}

test('an open phone preview can close after resizing to a wider layout', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 844 });
  const { unexpected } = await openRankings(page);
  const preview = page.getByRole('button', { name: `Preview ${alex.name}` });
  await preview.press('Enter');
  const dialog = page.getByRole('dialog', { name: alex.name });
  await expect(dialog.getByRole('img', { name: 'Mains Mario' })).toBeVisible();

  await page.setViewportSize({ width: 721, height: 844 });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(preview).toHaveCount(0);
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus-visible')).toBeVisible();
  expect(unexpected).toEqual([]);
});

test('browser Back restores phone Rankings after the full profile link in Preview', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { requestedPlayers, unexpected } = await openRankings(page);
  const board = page.locator('.board');
  const search = board.getByRole('searchbox', { name: 'Search' });
  const company = board.getByRole('combobox', { name: 'Company' });
  const sort = board.getByRole('combobox', { name: 'Sort' });
  await search.fill('Café & Co');
  await chooseOption(company, 'SYD');
  await chooseOption(sort, 'eventCount');
  await board.getByRole('button', { name: `Preview ${alex.name}` }).press('Enter');
  const dialog = page.getByRole('dialog', { name: alex.name });
  await expect(dialog.getByRole('img', { name: 'Mains Mario' })).toBeVisible();
  await dialog.getByRole('link', { name: 'View full profile' }).press('Enter');
  await expect(page).toHaveURL(`/players/${alex.playerId}`);
  await expect(page.getByRole('heading', { level: 1, name: /^Alex Café & Co/ })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL('/');
  await expect(dialog).toBeHidden();
  await expect(search).toHaveValue('Café & Co');
  await expect(company).toHaveAttribute('data-value', 'SYD');
  await expect(sort).toHaveAttribute('data-value', 'eventCount');
  await expect(board.getByRole('listitem')).toHaveCount(2);
  await expect(board.getByRole('listitem').first()).toContainText(alex.name);
  expect(requestedPlayers).toEqual([alex.playerId]);
  expect(unexpected).toEqual([]);
});
