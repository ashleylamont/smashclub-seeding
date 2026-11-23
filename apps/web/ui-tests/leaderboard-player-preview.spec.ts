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

async function openRankings(page: Page) {
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
      missedEvents: 0,
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
    activityPolicy: { graceEvents: 1, penaltyPerEvent: 20, penaltyCap: 100 },
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
