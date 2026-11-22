import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { trpc } from '../src/lib/trpc';
import { mockEvent, ready } from './fixtures';

const ALICE = {
  id: '3048c081-1afa-4eab-a0a0-622853293ae2',
  name: 'Ace with an exceptionally long tournament alias',
  companyCode: 'ATL',
};
const BEA = { id: 'afcc7fd0-e377-4832-9de0-18a3fa0c194a', name: 'Bea B', companyCode: 'BNE' };
const CHRIS = { id: '438bd2b7-75c3-4505-bc41-6f5394ec4cc9', name: 'Chris C', companyCode: null };
const OLD_ALICE = 'da5eed93-edda-4e93-bd45-62266793aa20';
const ids = new Map([ALICE, BEA, CHRIS].map((player) => [player.id, player]));
type Data = Awaited<ReturnType<typeof trpc.public.headToHead.query>>;

function pairUrl(first: string, second: string) {
  return `/head-to-head?first=${first}&second=${second}`;
}

async function comparisonFixture(page: Page, { noSharedNight = false } = {}) {
  const fixture = await mockEvent(page);
  fixture.responses['public.leaderboard'] = {
    computedAt: null,
    model: 'whr',
    eventCount: 0,
    activityPolicy: { graceEvents: 1, penaltyPerEvent: 20, penaltyCap: 100 },
    rows: [],
  };
  fixture.responses['public.ratingHistory'] = { events: [], players: [] };
  fixture.responses['public.tournaments'] = [];
  fixture.responses['eventOps.publicEvents'] = [];
  fixture.responses['public.player'] = {
    player: { ...ALICE, companyName: 'Smash Club', verified: false, characters: [] },
    rating: null,
    events: [],
    nights: [],
    recomputeId: null,
    model: 'whr',
    ratingScope: 'night',
    doublesResults: [],
    doublesMatches: [],
  };
  const pairs: { first?: string; second?: string }[] = [];
  fixture.queryResponses.set('public.headToHead', (input): Data => {
    const pair = input as (typeof pairs)[number];
    pairs.push(pair);
    const first = ids.get(pair.first === OLD_ALICE ? ALICE.id : (pair.first ?? '')) ?? null;
    const second = ids.get(pair.second === OLD_ALICE ? ALICE.id : (pair.second ?? '')) ?? null;
    if ((pair.first && !first) || (pair.second && !second))
      return { status: 'missing_player', players: [first, second] };
    if (!first || !second) return { status: 'choose_players', players: [first, second] };
    if (first.id === second.id) return { status: 'same_player', players: [first, second] };
    if (first.id === CHRIS.id || second.id === CHRIS.id)
      return {
        status: 'ready',
        players: [first, second],
        history: { wins: [0, 0], gamesWon: [0, 0], scoredMeetings: 0, recent: [] },
        forecast: null,
        ratingNight: null,
      };
    const aliceFirst = first.id === ALICE.id;
    const aliceEstimate = { preRating: 1455, postRating: 1510.5, prePenalty: 40, postPenalty: 0 };
    const beaEstimate = { preRating: 1560, postRating: 1540.5, prePenalty: 0, postPenalty: 0 };
    return {
      status: 'ready',
      players: [first, second],
      history: {
        wins: aliceFirst ? [2, 1] : [1, 2],
        gamesWon: aliceFirst ? [4, 1] : [1, 4],
        scoredMeetings: 2,
        recent: [
          {
            id: 'meeting-1',
            event: 'October Championship',
            slug: 'october',
            date: '2026-10-03T08:00:00Z',
            winner: aliceFirst ? 0 : 1,
            games: aliceFirst ? [2, 1] : [1, 2],
          },
          {
            id: 'meeting-2',
            event: 'September finals',
            slug: 'september',
            date: '2026-09-03T08:00:00Z',
            winner: aliceFirst ? 1 : 0,
            games: null,
          },
        ],
      },
      forecast: {
        firstWinChance: aliceFirst ? 0.674 : 0.326,
        ratedAt: '2026-10-04T00:00:00Z',
        provisional: true,
      },
      ratingNight: noSharedNight
        ? null
        : {
            eventKey: '2026-10-03',
            estimates: aliceFirst ? [aliceEstimate, beaEstimate] : [beaEstimate, aliceEstimate],
          },
    };
  });
  fixture.queryResponses.set('public.searchPlayers', (input) => {
    const term = (input as { query: string }).query.toLowerCase();
    return [...ids.values()]
      .filter((player) => player.name.toLowerCase().includes(term))
      .map((player) => ({ ...player, verified: false }));
  });
  return { ...fixture, pairs };
}

async function review(page: Page, testInfo: TestInfo, name: string) {
  await ready(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({ fullPage: true, path: testInfo.outputPath(`${name}.png`) });
}

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440]) {
    test(`head to head works by keyboard at ${width}px in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      const fixture = await comparisonFixture(page);
      await page.goto(`/players/${ALICE.id}`);
      await expect(page.getByRole('heading', { name: ALICE.name, exact: true })).toBeVisible();
      const start = page.getByRole('link', { name: 'Compare head to head' });
      await start.press('Enter');
      await expect(page).toHaveURL(new RegExp(`/head-to-head\\?first=${ALICE.id}$`));
      const first = page.getByRole('button', { name: `Change first player, ${ALICE.name}` });
      await expect(first).toBeVisible();

      const select = page.getByRole('button', { name: 'Choose second player' });
      await select.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Choose second player' });
      const search = dialog.getByRole('textbox', { name: 'Search by public alias' });
      await expect(search).toBeFocused();
      await search.fill('bea');
      await expect(dialog.getByRole('button', { name: 'Bea B BNE' })).toBeVisible();
      await review(page, testInfo, 'player-picker');
      await search.press('Enter');
      await expect(dialog).not.toBeVisible();
      const second = page.getByRole('button', { name: `Change second player, ${BEA.name}` });
      await expect(second).toBeFocused();
      await expect(page).toHaveURL(new RegExp(`first=${ALICE.id}&second=${BEA.id}$`));

      const actual = page.getByRole('region', { name: 'Played singles' });
      await expect(actual).toContainText('2 set wins');
      await expect(actual).toContainText('Game scores recorded in 2 of 3 sets.');
      const forecast = page.getByRole('region', { name: 'Current WHR estimate' });
      await expect(forecast).toContainText('67%');
      await expect(forecast).toContainText('33%');
      await expect(forecast).toContainText('provisional');
      await expect(forecast.locator('time')).toHaveAttribute('datetime', '2026-10-04T00:00:00Z');
      const ratingNight = page.getByRole('region', { name: 'Skill gap by night' });
      await expect(ratingNight.getByText('105.0 points')).toBeVisible();
      await expect(ratingNight.getByText('30.0 points')).toBeVisible();
      await expect(ratingNight.getByText(`${BEA.name} ahead`)).toHaveCount(2);
      await expect(ratingNight.getByText('40 → 0 points')).toBeVisible();
      await expect(ratingNight.locator('time')).toHaveAttribute('datetime', '2026-10-03');
      const recent = page.getByRole('region', { name: 'Recent meetings' });
      await expect(recent.getByRole('link', { name: 'October Championship' })).toHaveAttribute(
        'href',
        '/tournaments/october',
      );
      await expect(recent).toContainText('Game score unavailable');
      await review(page, testInfo, 'comparison');

      const swap = page.getByRole('link', { name: 'Swap players' });
      await swap.press('Enter');
      await expect(swap).toBeFocused();
      await expect(page).toHaveURL(new RegExp(`first=${BEA.id}&second=${ALICE.id}$`));
      await expect(actual.locator('dt').first()).toHaveText(BEA.name);
      await expect(forecast.locator('dd').first()).toHaveText('33%');
      await expect(ratingNight.getByText(`${BEA.name} ahead`)).toHaveCount(2);
      await expect(ratingNight.getByText('40 → 0 points')).toBeVisible();
      await expect(recent.getByRole('listitem').first()).toContainText('2–1');
      await page.reload();
      await expect(actual.locator('dt').first()).toHaveText(BEA.name);
      await expect(recent.getByRole('listitem').first()).toContainText(`${ALICE.name} won`);
      expect(fixture.unexpected).toEqual([]);
    });
  }

test('the public route handles canonical redirects, duplicate selection, no meetings and discovery', async ({
  page,
}, testInfo) => {
  const fixture = await comparisonFixture(page, { noSharedNight: true });
  await page.goto(pairUrl(OLD_ALICE, BEA.id));
  await expect(page).toHaveURL(new RegExp(`first=${ALICE.id}&second=${BEA.id}$`));
  await expect(page.getByRole('heading', { name: 'Played singles' })).toBeVisible();
  const ratingNight = page.getByRole('region', { name: 'Skill gap by night' });
  await expect(ratingNight).toContainText('A comparison needs a night with rated sets for both');
  expect(fixture.pairs).toContainEqual({ first: OLD_ALICE, second: BEA.id });
  await review(page, testInfo, 'rated-without-a-shared-night');

  await page.goto(pairUrl(ALICE.id, OLD_ALICE));
  await expect(page.getByText('Choose two different players')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Current WHR estimate' })).toHaveCount(0);

  await page.goto(pairUrl(ALICE.id, CHRIS.id));
  await expect(page.getByText('No recorded singles meetings for this pair.')).toBeVisible();
  await expect(ratingNight).toHaveCount(0);
  await expect(
    page.getByText('An estimate needs a current published WHR rating', { exact: false }),
  ).toBeVisible();
  await review(page, testInfo, 'unrated-no-meetings');

  await page.goto('/');
  const discover = page.getByRole('link', { name: 'Compare players head to head' });
  await expect(discover).toHaveAttribute('href', '/head-to-head');
  await discover.press('Enter');
  await expect(page.getByRole('button', { name: 'Choose first player' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose second player' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Current WHR estimate' })).toHaveCount(0);
  expect(fixture.unexpected).toEqual([]);
});
