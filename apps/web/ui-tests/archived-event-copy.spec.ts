import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { PublicEventNight } from '../src/lib/publicEvents';
import { mockEvent, PLAN_ID, PLAYER_NAME, ready } from './fixtures';

const cancelled = {
  id: PLAN_ID,
  name: 'Nemesis · Cancelled October event with a longer tournament name',
  eventDate: '2026-10-04T04:00:00Z',
  status: 'cancelled',
  bracketMode: 'native',
  competitionFormat: 'singles',
  drawPaused: false,
} satisfies PublicEventNight;
const completed = {
  ...cancelled,
  id: 'fb9a88ea-57f3-46fd-a480-7ee2f4798e3f',
  name: 'Nemesis · Completed October event with a longer tournament name',
  status: 'complete',
} satisfies PublicEventNight;

async function archiveFixture(page: Page, theme: 'dark' | 'light', width: number) {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
  const fixture = await mockEvent(page);
  fixture.snapshot.announcements = [];
  Object.assign(fixture.snapshot.plan, cancelled);
  return fixture;
}

async function reviewRoute(page: Page, info: TestInfo, file: string) {
  await page.evaluate(() => scrollTo(0, 0));
  await page.mouse.move(0, 0);
  await ready(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({ path: info.outputPath(`${file}.png`), fullPage: true });
}

for (const theme of ['dark', 'light'] as const) {
  for (const width of [390, 1440]) {
    test(`event archives and prizes use factual copy at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      const fixture = await archiveFixture(page, theme, width);
      const played = fixture.snapshot.matches.find(
        (match) => match.status === 'complete' && match.outcome === 'played',
      )!;
      fixture.snapshot.matches = [played];
      fixture.snapshot.placements = [];
      fixture.snapshot.prizes[1]!.playerName = PLAYER_NAME;

      fixture.responses['eventOps.publicEvents'] = [];
      await page.goto('/play');
      const open = page.getByRole('region', { name: 'Open event nights' });
      await expect(open).toContainText('No events are published yet.');
      await expect(page.getByRole('button', { name: /Recent finished events/ })).toHaveCount(0);
      await reviewRoute(page, testInfo, 'events-empty');

      fixture.responses['eventOps.publicEvents'] = [cancelled, completed];
      await page.reload();
      await expect(open).toContainText('No open events right now.');
      await expect(open).not.toContainText('No events are published yet.');
      const archive = page.getByRole('button', { name: 'Recent finished events (2)' });
      await archive.focus();
      await expect(archive).toBeFocused();
      await page.keyboard.press('Space');
      await expect(archive).toHaveAttribute('aria-expanded', 'true');
      const cancelledCard = page.getByRole('article').filter({ hasText: cancelled.name });
      const completedCard = page.getByRole('article').filter({ hasText: completed.name });
      const cancelledLink = cancelledCard.getByRole('link', { name: 'View event →' });
      const completedLink = completedCard.getByRole('link', { name: 'View results →' });
      await expect(cancelledCard).toContainText('· Cancelled');
      await expect(cancelledLink).toHaveAttribute('href', `/play/${cancelled.id}`);
      await expect(completedCard).toContainText('· Finished');
      await expect(completedLink).toHaveAttribute('href', `/play/${completed.id}#event-results`);
      await reviewRoute(page, testInfo, 'events-archives');

      await cancelledLink.focus();
      await expect(cancelledLink).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(`/play/${cancelled.id}`);
      await expect(page.getByRole('heading', { name: cancelled.name, level: 1 })).toBeVisible();
      await expect(
        page
          .getByRole('navigation', { name: 'Event sections' })
          .getByRole('link', { name: 'Results', exact: true }),
      ).toHaveAttribute('href', '#event-results');
      const emptyMatches = page.getByText('No matches in this view. Change the filters or go to');
      const emptyResultsLink = emptyMatches.getByRole('link', { name: 'Recorded results' });
      await expect(emptyResultsLink).toHaveAttribute('href', '#event-results');
      await expect(emptyResultsLink).toHaveCSS('text-decoration-line', 'underline');
      await emptyResultsLink.focus();
      await expect(emptyResultsLink).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(`/play/${cancelled.id}#event-results`);
      const results = page.getByRole('region', { name: 'Results', exact: true });
      const brackets = page.getByRole('region', { name: 'Brackets', exact: true });
      for (const event of [cancelled, completed]) {
        if (event === completed) {
          Object.assign(fixture.snapshot.plan, completed);
          await page.goto(`/play/${completed.id}#event-results`);
          await expect(page.getByRole('heading', { name: completed.name, level: 1 })).toBeVisible();
        }
        await expect(emptyResultsLink).toBeVisible();
        await expect(brackets).toContainText('No bracket is recorded for this event.');
        await expect(brackets).not.toContainText('Brackets will appear here');
        await expect(results.getByRole('heading', { name: 'Recorded results' })).toBeVisible();
        await expect(results).toContainText(played.label);
        await expect(results.getByRole('heading', { name: 'Prizes', exact: true })).toBeVisible();
        await expect(results.getByRole('heading', { name: 'On the line' })).toHaveCount(0);
        const award = results.getByRole('article').filter({ hasText: 'Good games award' });
        await expect(award).toContainText(PLAYER_NAME);
        await expect(award).toContainText('For bringing the club spirit');
        const trophy = results.getByRole('article').filter({ hasText: 'Upper champion' });
        await expect(trophy).toContainText('recipient to be confirmed');
        await expect(trophy.locator('strong')).toHaveCount(0);
        await reviewRoute(page, testInfo, `hub-${event.status}`);
      }
      Object.assign(fixture.snapshot.plan, { structure: 'round_robin' });
      await page.reload();
      await expect(brackets).toContainText(
        'This event uses pool standings to decide the result; there is no finals bracket.',
      );
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.submissions).toEqual([]);
    });

    test(`cancelled events show recorded results only when present at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      const fixture = await archiveFixture(page, theme, width);
      const unplayed = fixture.snapshot.matches.find((match) => match.status === 'ready')!;
      const placements = fixture.snapshot.placements;
      fixture.snapshot.matches = [unplayed];
      fixture.snapshot.placements = [];
      fixture.snapshot.prizes = [];
      Object.assign(fixture.snapshot.plan, { structure: 'dual_division' });
      await page.goto(`/play/${cancelled.id}`);
      await expect(page.getByRole('heading', { name: cancelled.name, level: 1 })).toBeVisible();
      const emptyMatches = page.getByText('No matches in this view. Change the filters or go to');
      const emptyResultsLink = emptyMatches.getByRole('link', { name: 'Recorded results' });
      const results = page.getByRole('region', { name: 'Results', exact: true });
      await emptyResultsLink.focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(`/play/${cancelled.id}#event-results`);
      await expect(results).toContainText('No recorded sets in this view.');
      await expect(results).not.toContainText('Results appear here once confirmed.');
      await expect(
        page.getByText('This event is closed. Score reporting is unavailable.', { exact: true }),
      ).toBeVisible();
      await expect(page.getByText('Results remain available.', { exact: false })).toHaveCount(0);
      await expect(page.getByText('Recorded tournament results', { exact: true })).toHaveCount(0);
      await reviewRoute(page, testInfo, 'hub-cancelled-no-results');

      fixture.snapshot.matches = [];
      await page.reload();
      const schedule = page.getByRole('region', { name: 'Event schedule' });
      await expect(schedule).toContainText('No matches are recorded for this event.');
      await expect(schedule).not.toContainText('will publish pairings');
      await reviewRoute(page, testInfo, 'hub-cancelled-no-matches');

      fixture.snapshot.placements = placements;
      await page.reload();
      await expect(
        results.getByRole('heading', { name: 'Confirmed pool standings' }),
      ).toBeVisible();
      await expect(results).toContainText('No recorded sets in this view.');
      await expect(page.getByText('Results remain available.', { exact: false })).toBeVisible();

      fixture.snapshot.placements = [];
      Object.assign(fixture.snapshot.plan, { historicalResultsSlug: 'archived-night' });
      await page.reload();
      await expect(
        results.getByRole('link', { name: 'View historical results →' }),
      ).toHaveAttribute('href', '/events/archived-night');
      await expect(page.getByText('Results remain available.', { exact: false })).toBeVisible();
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.submissions).toEqual([]);
    });
  }
}
