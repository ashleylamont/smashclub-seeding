import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { PublicEventNight } from '../src/lib/publicEvents';
import { mockEvent, PLAN_ID, PLAYER_NAME, ready } from './fixtures';

const finished = {
  id: PLAN_ID,
  name: 'Nemesis · Finished event with a longer tournament name',
  eventDate: '2026-10-04T04:00:00Z',
  status: 'complete',
  bracketMode: 'native',
  competitionFormat: 'singles',
  drawPaused: false,
} satisfies PublicEventNight;
const imported = { ...finished, bracketMode: 'challonge' } as const;

async function reviewRoute(page: Page, info: TestInfo, file: string) {
  await ready(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({ path: info.outputPath(`${file}.png`), fullPage: true });
}

async function enterArchive(page: Page) {
  await page.goto('/play');
  await page.getByRole('button', { name: 'Recent finished events (1)' }).press('Enter');
  const link = page.getByRole('link', { name: 'View archive', exact: true });
  await expect(link).toHaveAttribute('href', `/play/${PLAN_ID}#event-archive`);
  await link.press('Enter');
  await expect(page).toHaveURL(`/play/${PLAN_ID}#event-archive`);
  await expect(page.getByRole('heading', { name: finished.name, level: 1 })).toBeVisible();
}

for (const theme of ['dark', 'light'] as const) {
  for (const width of [390, 1440]) {
    test(`finished directory opens available archive content at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const fixture = await mockEvent(page, { bracket: true });
      const { snapshot, responses } = fixture;
      const nativeBrackets = snapshot.nativeBrackets;
      const played = snapshot.matches.find(
        (match) => match.status === 'complete' && match.outcome === 'played',
      )!;
      played.player1Name = PLAYER_NAME;
      const placements = snapshot.placements;
      Object.assign(snapshot.plan, imported, { liveOwned: false });
      snapshot.matches = [];
      snapshot.nativeBrackets = [];
      snapshot.announcements = [];
      snapshot.placements = [];
      snapshot.prizes = [];
      Object.assign(snapshot.brackets[0]!, { slug: 'rehearsal-upper' });
      Object.assign(snapshot.brackets[2]!, { slug: 'rehearsal-lower' });
      responses['eventOps.publicEvents'] = [imported];

      await enterArchive(page);
      const bracketPanel = page.getByRole('region', { name: 'Brackets', exact: true });
      const links = bracketPanel.getByRole('navigation', { name: 'Challonge brackets' });
      await expect(
        bracketPanel.getByRole('heading', { name: 'Brackets on Challonge' }),
      ).toBeVisible();
      await expect(bracketPanel).toBeFocused();
      await expect(bracketPanel).toBeInViewport();
      await expect(links.getByRole('link')).toHaveCount(2);
      const upperLink = links.getByRole('link', { name: /Upper · Groups & championship/i });
      const lowerLink = links.getByRole('link', { name: /Lower · Groups & championship/i });
      await expect(upperLink).toHaveAttribute('href', 'https://challonge.com/rehearsal-upper');
      await expect(lowerLink).toHaveAttribute('href', 'https://challonge.com/rehearsal-lower');
      await page.keyboard.press('Tab');
      await expect(upperLink).toBeFocused();
      await expect(upperLink).toHaveCSS('outline-style', 'solid');
      const results = page.getByRole('region', { name: 'Results', exact: true });
      await expect(results).toHaveCount(0);
      await expect(page.getByRole('region', { name: 'Pools', exact: true })).toHaveCount(0);
      await expect(page.getByText(/What next|Find my matches|Score reporting/)).toHaveCount(0);
      await reviewRoute(page, testInfo, 'imported-brackets');

      await page.goto(`/play/${PLAN_ID}#event-results`);
      await page.reload();
      await expect(bracketPanel).toBeFocused();
      snapshot.placements = placements;
      await page.reload();
      await expect(
        results.getByRole('heading', { name: 'Confirmed pool standings' }),
      ).toBeVisible();
      await expect(results.getByText('No recorded sets in this view.')).toHaveCount(0);
      await expect(links.getByRole('link')).toHaveCount(2);

      Object.assign(snapshot.plan, finished, { liveOwned: true });
      snapshot.matches = [played];
      snapshot.nativeBrackets = nativeBrackets;
      snapshot.placements = [];
      responses['eventOps.publicEvents'] = [finished];
      await enterArchive(page);
      await expect(results).toBeFocused();
      await expect(results).toBeInViewport();
      const score = results
        .getByRole('article')
        .filter({ hasText: PLAYER_NAME })
        .locator('.event-contender strong');
      await expect(score).toHaveText(['2', '0']);
      await expect(page.getByRole('spinbutton')).toHaveCount(0);
      await reviewRoute(page, testInfo, 'native-results');

      Object.assign(snapshot.plan, imported, { liveOwned: false });
      snapshot.matches = [];
      snapshot.nativeBrackets = [];
      snapshot.brackets.forEach((bracket) => (bracket.slug = null));
      responses['eventOps.publicEvents'] = [imported];
      await enterArchive(page);
      const empty = page.getByRole('region', { name: 'Event archive' });
      await expect(empty).toContainText('No results or brackets are available for this event.');
      await expect(results).toHaveCount(0);
      await expect(bracketPanel).toHaveCount(0);
      await reviewRoute(page, testInfo, 'empty-archive');
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.submissions).toEqual([]);
    });
  }
}

test('adopted historical archive retains recorded links on a native plan', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('smashclub:theme', 'light'));
  const { snapshot, responses, unexpected } = await mockEvent(page);
  Object.assign(snapshot.plan, finished, {
    liveOwned: false,
    historicalResultsSlug: 'adopted-upper',
    resultsSlug: 'adopted-upper',
  });
  snapshot.matches = [];
  snapshot.entrants = [];
  snapshot.placements = [];
  snapshot.announcements = [];
  snapshot.prizes = [];
  Object.assign(snapshot.brackets[0]!, { slug: 'adopted-upper' });
  Object.assign(snapshot.brackets[2]!, { slug: 'adopted-lower' });
  responses['eventOps.publicEvents'] = [finished];

  await enterArchive(page);
  const results = page.getByRole('region', { name: 'Results', exact: true });
  await expect(results).toBeFocused();
  const standings = results.getByRole('link', { name: 'View historical results →' });
  await expect(standings).toHaveAttribute('href', '/events/adopted-upper');
  const brackets = page.getByRole('navigation', { name: 'Challonge brackets' });
  await expect(brackets.getByRole('link')).toHaveCount(2);
  await expect(brackets.getByRole('link', { name: /upper/i })).toHaveAttribute(
    'href',
    'https://challonge.com/adopted-upper',
  );
  await expect(brackets.getByRole('link', { name: /lower/i })).toHaveAttribute(
    'href',
    'https://challonge.com/adopted-lower',
  );
  await expect(page.getByRole('region', { name: 'Pools', exact: true })).toHaveCount(0);
  await expect(page.getByText(/No recorded sets|What next|Score reporting/)).toHaveCount(0);
  await page.keyboard.press('Tab');
  await expect(standings).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(brackets.getByRole('link', { name: /upper/i })).toBeFocused();
  await reviewRoute(page, testInfo, 'adopted-native-plan');
  expect(unexpected).toEqual([]);
});

test('prizes-only archive focuses its recorded prize', async ({ page }, testInfo) => {
  const { snapshot, responses, unexpected } = await mockEvent(page);
  Object.assign(snapshot.plan, imported, { liveOwned: false });
  snapshot.matches = [];
  snapshot.placements = [];
  snapshot.announcements = [];
  snapshot.prizes = snapshot.prizes.filter((prize) => prize.playerName);
  responses['eventOps.publicEvents'] = [imported];

  await enterArchive(page);
  const prizes = page.getByRole('region', { name: 'Prizes', exact: true });
  await expect(prizes).toBeFocused();
  await expect(prizes).toContainText('Good games award');
  await expect(prizes).toContainText('Roy');
  await expect(page.getByRole('region', { name: 'Results', exact: true })).toHaveCount(0);
  await reviewRoute(page, testInfo, 'prizes-only');
  expect(unexpected).toEqual([]);
});
