import { readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { LeaderboardData, RatingHistoryData } from '../src/lib/apiTypes';
import { chooseOption } from '../test-support/controls';
import { bracketCaptureOptions, mockEvent, ready } from './fixtures';

const returning = {
  playerId: 'ac184b5a-fba4-4bc9-9ee9-c1610d3c8373',
  name: 'Returning player with an exceptionally long tournament alias',
  rank: 1,
  conservativeRating: 1400,
};
const debut = {
  playerId: 'afcc7fd0-e377-4832-9de0-18a3fa0c194a',
  name: 'Debut player',
  rank: 2,
  conservativeRating: 1200,
};
const captureStyle = `${readFileSync(bracketCaptureOptions.stylePath, 'utf8')}
.board-head { position: static !important; }`;
const dates = ['2026-07-28', '2026-08-25', '2026-09-29'];
const nights = [
  { playerId: returning.playerId, eventKey: dates[0]!, postRating: 1600, postRd: 80, played: true },
  {
    playerId: returning.playerId,
    eventKey: dates[1]!,
    postRating: 1680,
    postRd: 110,
    played: false,
  },
  { playerId: returning.playerId, eventKey: dates[2]!, postRating: 1710, postRd: 90, played: true },
  { playerId: debut.playerId, eventKey: dates[1]!, postRating: 1460, postRd: 135, played: true },
  { playerId: debut.playerId, eventKey: dates[2]!, postRating: 1450, postRd: 118, played: true },
];

async function mockRatingHistory(
  page: Page,
  withNightLedger = true,
  withSetHistory = true,
  emptySelection = false,
  unavailableNight = false,
) {
  const fixture = await mockEvent(page);
  const leaderboard: LeaderboardData = {
    computedAt: '2026-09-29T10:00:00Z',
    model: 'whr',
    eventCount: 3,
    rows: [returning, debut].map((player) => ({
      ...player,
      previousRank: player.rank,
      rankDelta: 0,
      league: 'Club',
      skillRating: 1710,
      skillSd: 90,
      clubRating: 1710,
      activityPenalty: 0,
      nextMissPenalty: 20,
      missedEvents: 0,
      attendanceStreak: 1,
      isProvisional: false,
      rating: 1710,
      rd: 90,
      effectiveRd: 90,
      wins: 1,
      losses: 1,
      matchCount: 2,
      tournamentCount: 2,
      eventCount: 2,
      sampleConfidence: 0.48,
      rookieRatio: 0,
      lastPlayedDate: '2026-09-29T08:00:00Z',
      companyCode: null,
      companyName: null,
      verified: false,
      characters: [],
    })),
    activityPolicy: { graceEvents: 1, penaltyPerEvent: 20, penaltyCap: 100 },
  };
  fixture.responses['public.leaderboard'] = leaderboard;
  const history: RatingHistoryData = {
    events: (withSetHistory ? nights : [])
      .filter((night) => night.played)
      .sort((a, b) => a.eventKey.localeCompare(b.eventKey))
      .map(({ played: _played, ...night }, seq) => ({
        ...night,
        ...(unavailableNight && night.eventKey === dates[0]
          ? { postRating: null, postRd: null }
          : { postRating: night.postRating, postRd: night.postRd }),
        seq,
        tournamentId: returning.playerId,
        isDecay: false,
        won: seq % 2 === 0,
      })),
    players: [returning, debut],
  };
  fixture.queryResponses.set('public.ratingHistory', (input) => {
    expect(input).toEqual({ verifiedFits: true });
    return history;
  });
  fixture.responses['public.tournaments'] = [];
  fixture.responses['eventOps.publicEvents'] = [];
  const requests: string[][] = [];
  fixture.queryResponses.set('public.ratingNightHistory', (input) => {
    const { playerIds, verifiedFits } = input as { playerIds: string[]; verifiedFits: boolean };
    expect(verifiedFits).toBe(true);
    requests.push(playerIds);
    const points = emptySelection
      ? []
      : nights.filter(
          (night) => playerIds.includes(night.playerId) && (withNightLedger || night.played),
        );
    return {
      mode: withNightLedger ? 'nightly' : 'played',
      eventKeys: withNightLedger
        ? [...new Set(points.map((night) => night.eventKey))].sort()
        : dates,
      points: points.map((point) =>
        unavailableNight && point.eventKey === dates[0]
          ? { ...point, postRating: null, postRd: null }
          : point,
      ),
    };
  });
  return { requests, unexpected: fixture.unexpected };
}

for (const theme of ['light', 'dark'] as const) {
  for (const width of [390, 1440]) {
    test(`ratings show the missed-night estimate at ${width}px in ${theme}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      const { requests, unexpected } = await mockRatingHistory(page);
      await page.goto('/');
      const chart = page.locator('.ratings-over-time');
      const plot = chart.getByRole('application', { name: 'Player estimates by club night' });
      await plot.focus();
      await expect(chart.locator('.tooltip-label')).toHaveText(dates[0]!);
      await expect(chart.locator('.tooltip-row')).toHaveCount(1);
      await plot.press('ArrowRight');
      await expect(chart.locator('.tooltip-label')).toHaveText(dates[1]!);
      await expect(chart.locator('.tooltip-row').filter({ hasText: returning.name })).toContainText(
        '1680',
      );
      await expect(chart.locator('.tooltip-row').filter({ hasText: returning.name })).toContainText(
        'Missed night',
      );
      await expect(chart.locator('.tooltip-row').filter({ hasText: debut.name })).toContainText(
        '1460',
      );
      expect(requests).toEqual([[returning.playerId, debut.playerId].sort()]);
      await ready(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      await page.screenshot({
        style: captureStyle,
        fullPage: true,
        path: info.outputPath('rankings.png'),
      });
      await plot.press('ArrowLeft');
      await plot.press('ArrowRight');
      await expect(chart.locator('.tooltip-label')).toHaveText(dates[1]!);
      await page.screenshot({ path: info.outputPath('missed-night.png') });
      const scan = await new AxeBuilder({ page }).include('.ratings-over-time').analyze();
      expect(scan.violations).toEqual([]);
      await chooseOption(chart.getByRole('combobox', { name: 'Y-axis' }), 'cautious');
      await plot.focus();
      await plot.press('ArrowLeft');
      await plot.press('ArrowRight');
      await expect(chart.locator('.tooltip-label')).toHaveText(dates[1]!);
      await expect(chart.locator('.tooltip-row').filter({ hasText: returning.name })).toContainText(
        '1460',
      );
      expect(unexpected).toEqual([]);
    });
  }
}

test('ratings keep unrecorded legacy nights empty', async ({ page }) => {
  await mockRatingHistory(page, false);
  await page.goto('/');
  const chart = page.locator('.ratings-over-time');
  await expect(chart).toContainText('Showing the available played-night estimates.');
  const plot = chart.getByRole('application');
  await plot.focus();
  await expect(chart.locator('.tooltip-label')).toHaveText(dates[0]!);
  await plot.press('ArrowRight');
  await expect(chart.locator('.tooltip-label')).toHaveText(dates[1]!);
  await expect(chart.locator('.tooltip-row')).toHaveCount(1);
  await expect(chart.locator('.tooltip-row')).toContainText(debut.name);
});

test('the published chart can load independently of set history', async ({ page }) => {
  await mockRatingHistory(page, true, false);
  await page.goto('/');
  const chart = page.locator('.ratings-over-time');
  const plot = chart.getByRole('application');
  await expect(plot).toBeVisible();
  await plot.focus();
  await expect(chart.locator('.tooltip-row')).toContainText('1600');
});

for (const theme of ['light', 'dark'] as const) {
  for (const width of [390, 1440]) {
    test(`keyboard navigation across a legacy gap at ${width}px in ${theme}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      const { requests, unexpected } = await mockRatingHistory(page, false);
      await page.goto('/');
      const chart = page.locator('.ratings-over-time');
      const plot = chart.getByRole('application', { name: 'Player estimates by club night' });
      const status = chart.getByRole('status');
      const playerRows = status.locator('.tooltip-row');
      await expect(plot).toContainText(dates[1]!);
      await chart.locator('.chart-legend').getByRole('button', { name: debut.name }).click();
      await expect.poll(() => requests.at(-1)).toEqual([returning.playerId]);
      await expect(plot).toContainText(dates[1]!);
      await plot.focus();
      await expect(status.getByText(dates[0]!, { exact: true })).toBeVisible();
      await expect(playerRows).toHaveCount(1);
      await expect(playerRows).toContainText(returning.name);
      await expect(playerRows.getByText('1600', { exact: true })).toBeVisible();

      await plot.press('ArrowRight');
      await ready(page);
      await expect(status.getByText(dates[1]!, { exact: true })).toBeVisible();
      await expect(status.getByText('No recorded estimates for these players.')).toBeVisible();
      await expect(playerRows).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      await chart.screenshot({ path: info.outputPath('legacy-gap.png') });
      const scan = await new AxeBuilder({ page }).include('.ratings-over-time').analyze();
      expect(scan.violations).toEqual([]);

      await plot.press('Escape');
      await expect(status).toBeHidden();
      await expect(plot).toBeFocused();
      await plot.press('ArrowRight');
      await expect(status.getByText(dates[2]!, { exact: true })).toBeVisible();
      await expect(playerRows).toHaveCount(1);
      await expect(playerRows).toContainText(returning.name);
      await expect(playerRows.getByText('1710', { exact: true })).toBeVisible();
      expect(unexpected).toEqual([]);
    });
  }
}

test('a modern selection absent from the published run cannot recover cached played estimates', async ({
  page,
}) => {
  await mockRatingHistory(page, true, true, true);
  await page.goto('/');
  const chart = page.locator('.ratings-over-time');
  await expect(chart).toContainText('No night estimates for these players.');
  await expect(chart.getByRole('application')).toHaveCount(0);
});

for (const theme of ['light', 'dark'] as const) {
  for (const width of [390, 1440]) {
    test(`an unavailable rating night leaves a comparison gap at ${width}px in ${theme}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      const { unexpected } = await mockRatingHistory(page, true, true, false, true);
      await page.goto('/');
      const chart = page.locator('.ratings-over-time');
      const plot = chart.getByRole('application', { name: 'Player estimates by club night' });
      const status = chart.getByRole('status');
      await expect(chart).toContainText('Gaps show unavailable night estimates.');
      const row = page.locator('.board-row').filter({ hasText: returning.name });
      await expect(row.locator('.form .pip')).toHaveCount(2);
      await expect(row.locator('.spark svg')).toHaveCount(0);
      await plot.focus();
      await expect(status).toContainText(dates[0]!);
      await expect(status).toContainText('Night estimate unavailable.');
      await expect(status).not.toContainText('1600');
      await ready(page);
      await chart.screenshot({ path: info.outputPath('unavailable-comparison.png') });
      await chooseOption(chart.getByRole('combobox', { name: 'Y-axis' }), 'cautious');
      await plot.focus();
      await plot.press('ArrowRight');
      await plot.press('ArrowLeft');
      await expect(status).toContainText('Night estimate unavailable.');
      await plot.press('ArrowRight');
      await expect(status).toContainText('1460');
      await expect(status).toContainText('Missed night');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      expect(
        (await new AxeBuilder({ page }).include('.ratings-over-time').analyze()).violations,
      ).toEqual([]);
      expect(unexpected).toEqual([]);
    });
  }
}
