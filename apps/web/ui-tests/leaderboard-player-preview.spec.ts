import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { LeaderboardData } from '../src/lib/apiTypes';
import { chooseOption } from '../test-support/controls';
import { mockEvent, ready } from './fixtures';

const alex = {
  playerId: '00000000-0000-4000-8000-000000000011',
  name: 'Alex & Co with a very long tournament alias from Western Sydney',
  rank: 2,
  clubRating: 1596,
  eventCount: 8,
};
const players = [
  {
    playerId: '00000000-0000-4000-8000-000000000010',
    name: 'Leading player',
    rank: 1,
    clubRating: 1710,
    eventCount: 4,
  },
  alex,
  {
    playerId: '00000000-0000-4000-8000-000000000012',
    name: 'Club newcomer',
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
  leadingPlayerMisses = 0,
) {
  const fixture = await mockEvent(page);
  const requestedPlayers: string[] = [];
  const leaderboard: LeaderboardData = {
    computedAt: '2026-09-29T10:00:00Z',
    model: 'whr',
    eventCount: 8,
    rows: players.map((player) => ({
      ...player,
      previousRank: player.rank + 1,
      rankDelta: 1,
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
      companyCode: 'SYD',
      companyName: 'Western Sydney',
      verified: true,
      characters: ['mario', 'kirby'],
    })),
    activityPolicy,
  };
  fixture.responses['public.leaderboard'] = leaderboard;
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
      await expect(page.getByRole('link', { name: /^Alex & Co/ })).toContainText('1596');
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
    4,
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

for (const width of [390, 1440]) {
  test.describe(`${width}px player rankings`, () => {
    test.use({ hasTouch: width === 390 });

    for (const theme of ['dark', 'light'] as const) {
      test(`opens a player preview without leaving the ranked board in ${theme}`, async ({
        page,
      }, info) => {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
        const { requestedPlayers, unexpected } = await openRankings(page);
        const board = page.locator('.board');
        const rows = board.getByRole('listitem');
        await expect(rows).toHaveCount(3);
        await expect(rows.first()).toContainText('Leading player');
        await ready(page);
        await page.screenshot({ path: info.outputPath('rankings.png'), fullPage: true });

        if (width === 390)
          await chooseOption(board.getByRole('combobox', { name: 'Sort' }), 'eventCount');
        else await board.getByRole('button', { name: 'Sort by events attended' }).press('Enter');
        await expect(rows.first()).toContainText(alex.name);
        const search = board.getByRole('searchbox', { name: 'Search' });
        await search.fill('player');
        await expect(rows).toHaveCount(1);
        await search.clear();
        await expect(rows).toHaveCount(3);
        await expect(rows.first()).toContainText(alex.name);

        const directLink = rows.first().getByRole('link', { name: /^Alex & Co/ });
        await expect(directLink).toHaveAttribute('href', `/players/${alex.playerId}`);
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
        await expect(rows.first()).toContainText(alex.name);
        await expect(page).toHaveURL(/\/$/);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
        expect(unexpected).toEqual([]);
      });
    }
  });
}
