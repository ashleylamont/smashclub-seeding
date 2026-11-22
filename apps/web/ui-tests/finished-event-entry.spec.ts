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
      Object.assign(snapshot.plan, { historicalResultsSlug: 'rehearsal-results' });
      snapshot.placements = placements;
      await page.reload();
      await expect(
        results.getByRole('link', { name: 'View historical results →' }),
      ).toHaveAttribute('href', '/events/rehearsal-results');
      await expect(
        results.getByRole('heading', { name: 'Confirmed pool standings' }),
      ).toBeVisible();
      await expect(results.getByText('No recorded sets in this view.')).toHaveCount(0);
      await expect(links.getByRole('link')).toHaveCount(2);

      Object.assign(snapshot.plan, finished, { historicalResultsSlug: null, liveOwned: true });
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
