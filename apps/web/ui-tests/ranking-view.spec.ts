import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { LeaderboardData, PlayerData } from '../src/lib/apiTypes';
import { chooseOption } from '../test-support/controls';
import { mockEvent, ready } from './fixtures';

const recomputeId = '40000000-0000-4000-8000-000000000001';
const currentNight = '2026-09-29';
const playedNight = '2026-09-24';
const alex = {
  playerId: '40000000-0000-4000-8000-000000000011',
  name: 'Alex with a long tournament alias from Western Sydney',
  rank: 2,
  lastPlayedDate: playedNight,
  eventCount: 1,
};
const players = [
  {
    playerId: '40000000-0000-4000-8000-000000000010',
    name: 'Long-absent leader',
    rank: 1,
    lastPlayedDate: '2025-01-01',
    eventCount: 5,
  },
  alex,
  {
    playerId: '40000000-0000-4000-8000-000000000012',
    name: 'Cam',
    rank: 3,
    lastPlayedDate: currentNight,
    eventCount: 10,
  },
];

async function mockRankingsAndProfile(page: Page, anchored: boolean) {
  await page.clock.setFixedTime(new Date('2026-10-06T12:00:00Z'));
  const fixture = await mockEvent(page);
  const skill = anchored ? 1553 : 1651;
  const clubRating = skill - 20;
  const board: LeaderboardData = {
    computedAt: '2026-09-29T10:00:00Z',
    model: 'whr',
    eventCount: 10,
    rows: players.map((player) => {
      const playerSkill = player.rank === 1 ? 1720 : player.rank === 2 ? skill : 1470;
      const activityPenalty = player.rank === 2 ? 20 : 0;
      return {
        ...player,
        previousRank: player.rank,
        rankDelta: 0,
        league: 'Club',
        skillRating: playerSkill,
        skillSd: 90,
        conservativeRating: playerSkill - 180,
        clubRating: playerSkill - activityPenalty,
        activityPenalty,
        nextMissPenalty: 20,
        missedEvents: player.rank === 2 ? 2 : 0,
        attendanceStreak: 0,
        isProvisional: player.rank === 2 && anchored,
        rating: player.rank === 2 ? 1651 : playerSkill,
        rd: 90,
        effectiveRd: 90,
        wins: player.rank === 2 ? 1 : 13,
        losses: player.rank === 2 ? 1 : 9,
        matchCount: player.rank === 2 ? 2 : 22,
        tournamentCount: player.eventCount,
        sampleConfidence: 0.48,
        rookieRatio: player.rank === 2 && anchored ? 1 : 0,
        companyCode: player.rank === 3 ? 'SYD' : null,
        companyName: player.rank === 3 ? 'Sydney' : null,
        verified: false,
        characters: [],
      };
    }),
    activityPolicy: { graceEvents: 1, penaltyPerEvent: 20, penaltyCap: 100 },
  };
  fixture.responses['public.leaderboard'] = board;
  fixture.responses['public.ratingHistory'] = { players: [], events: [] };
  fixture.responses['public.tournaments'] = [];
  fixture.responses['eventOps.publicEvents'] = [];
  const profile = {
    player: {
      id: alex.playerId,
      name: alex.name,
      companyCode: null,
      companyName: null,
      verified: false,
      characters: [],
    },
    rating: {
      ...board.rows[1]!,
      id: '40000000-0000-4000-8000-000000000004',
      recomputeId,
      vol: 0,
      effectiveRating: skill,
      mainMatchCount: anchored ? 0 : 2,
      rookieMatchCount: anchored ? 2 : 0,
      uniqueOpponentCount: 2,
      bridgeOpponentCount: anchored ? 0 : 2,
      isolationFactor: anchored ? 1 : 0,
    },
    model: 'whr',
    ratingScope: 'night',
    recomputeId,
    nights: [
      {
        eventKey: playedNight,
        played: true,
        preRating: 1627,
        postRating: 1651,
        postRd: 90,
        revisedRating: 1651,
        prePenalty: 0,
        postPenalty: 0,
      },
      ...['2026-09-26', currentNight].map((eventKey, index) => ({
        eventKey,
        played: false,
        preRating: 1651,
        postRating: 1651,
        postRd: 90,
        revisedRating: 1651,
        prePenalty: 0,
        postPenalty: index === 0 ? 0 : 20,
      })),
    ],
    events: [true, false].map((won, seq) => ({
      seq,
      isDecay: false,
      won,
      postRating: 1651,
      postRd: 90,
      revisedRating: 1651,
      revisedSd: 90,
      weight: 1,
      tournamentId: 'rankings-test-event',
      tournamentName: 'Club night',
      tournamentDate: `${playedNight}T08:00:00Z`,
      competitionFormat: 'singles',
      setId: null,
      resultStage: 'group',
      isRookie: anchored,
      opponentPlayerId: null,
      opponentName: seq === 0 ? 'Player A' : 'Player B',
    })),
    doublesMatches: [],
    doublesResults: [],
  } satisfies PlayerData;
  fixture.responses['public.player'] = profile;
  return { skill, clubRating, board, unexpected: fixture.unexpected };
}

for (const width of [390, 1440]) {
  for (const theme of ['dark', 'light'] as const) {
    test(`ranks and skill use their published meaning at ${width}px in ${theme}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const anchored = theme === 'dark';
      const {
        skill,
        clubRating,
        board: data,
        unexpected,
      } = await mockRankingsAndProfile(page, anchored);
      await page.goto('/');
      const board = page.locator('.board');
      const activeLink = board.getByRole('link', { name: /^Alex.*active rank 1.*club rating/i });
      await expect(board.locator('.board-count')).toContainText('Active rank');
      await expect(activeLink).toContainText(String(clubRating));
      await expect(board.getByRole('listitem')).toHaveCount(2);
      if (width === 390)
        await chooseOption(board.getByRole('combobox', { name: 'Sort' }), 'eventCount');
      else await board.getByRole('button', { name: 'Sort by events attended' }).press('Enter');
      await expect(board.getByRole('listitem').first()).toContainText('Cam');
      const search = board.getByRole('searchbox', { name: 'Search' });
      await search.fill('Alex');
      await expect(board.getByRole('listitem')).toHaveCount(1);
      await expect(activeLink).toBeVisible();
      await search.clear();
      const company = board.getByRole('combobox', { name: 'Company' });
      await chooseOption(company, 'SYD');
      await expect(board.getByRole('listitem')).toHaveCount(1);
      await expect(board.getByRole('link', { name: /^Cam.*active rank 2/i })).toBeVisible();
      await chooseOption(company, 'all');
      const legend = board.getByRole('button', { name: 'How to read the board' });
      await legend.press('Enter');
      await expect(legend).toHaveAttribute('aria-expanded', 'true');
      await expect(board.locator('.board-legend')).toContainText(
        'Movement uses the selected ranking field',
      );
      const guide = board.locator('.board-legend');
      const placing = guide.locator('.legend-term').filter({
        has: page.getByText('Tournament placing', { exact: true }),
      });
      await expect(placing.getByRole('definition')).toContainText(
        /finish in a bracket or division.*only eligible sets as rating evidence.*opponent strength/,
      );
      const seed = guide.locator('.legend-term').filter({
        has: page.getByText('Bracket seed', { exact: true }),
      });
      await expect(seed.getByRole('definition')).toContainText(
        /starting position in a draw.*saved skill and uncertainty.*who advances.*pool place and saved rating strength/,
      );
      await ready(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
      ).toEqual([]);
      await page.screenshot({ fullPage: true, path: info.outputPath('active-rank.png') });
      await legend.press('Enter');
      await expect(legend).toHaveAttribute('aria-expanded', 'false');
      await expect(legend).toBeFocused();
      await activeLink.press('Enter');

      const headline = page.locator('.profile-headline');
      await expect(page.locator('.profile-identity .eyebrow')).toHaveText('Published rank #2');
      await expect(headline.locator('.headline-value')).toHaveText(String(clubRating));
      const explain = headline.getByRole('button', { name: 'Explain: Club rating' });
      await explain.press('Enter');
      const help = page.getByRole('dialog', { name: 'Club rating' });
      await expect(help).toContainText('subtracts any attendance penalty from the skill estimate');
      await page.keyboard.press('Escape');
      await expect(explain).toBeFocused();
      const estimate = page.locator('.profile-stats .stat').filter({ hasText: 'Skill estimate' });
      await expect(estimate.locator('.num')).toHaveText(String(skill));
      await expect(estimate).toContainText('eligible sets and opponent strength');
      if (anchored)
        await expect(estimate).toContainText(
          'Rookie anchoring pulls this figure toward the starting estimate.',
        );
      else await expect(estimate).not.toContainText('Rookie anchoring');
      await ready(page);
      await page.screenshot({ fullPage: true, path: info.outputPath('published-profile.png') });
      const night = page.getByRole('region', { name: 'Rating changes by night' });
      await chooseOption(night.getByRole('combobox', { name: 'Rating night' }), playedNight);
      await expect(night).toContainText('1627.0 → 1651.0');
      await expect(page.getByRole('heading', { name: 'Match log (2 sets)' })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
      ).toEqual([]);

      await page.goBack();
      const hideInactive = board.getByRole('switch', { name: 'Hide inactive' });
      await expect(hideInactive).toBeChecked();
      await hideInactive.press('Space');
      await expect(hideInactive).not.toBeChecked();
      const publishedLink = board.getByRole('link', {
        name: /^Alex.*published rank 2.*club rating/i,
      });
      await expect(publishedLink).toHaveAttribute('href', `/players/${alex.playerId}`);
      await expect(board.locator('.board-count')).toContainText('Published rank');
      await expect(board.getByRole('listitem')).toHaveCount(3);
      await ready(page);
      await page.screenshot({ fullPage: true, path: info.outputPath('published-rank.png') });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
      ).toEqual([]);

      if (width === 1440 && theme === 'light') {
        data.rows[0]!.lastPlayedDate = currentNight;
        await hideInactive.press('Space');
        await expect(hideInactive).toBeChecked();
        await page.reload();
        await expect(hideInactive).toBeChecked();
        await expect(publishedLink).toBeVisible();
      }
      expect(unexpected).toEqual([]);
    });
  }
}
