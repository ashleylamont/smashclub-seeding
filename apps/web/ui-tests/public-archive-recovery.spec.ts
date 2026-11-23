import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { EventOverviewData, TournamentData } from '../src/lib/apiTypes';
import { mockEvent, ready } from './fixtures';

const slug = 'shared-archive-bracket';
const alias = 'An entrant with a long tournament alias in the public archive';
const tournament = {
  id: 'archive-bracket',
  slug,
  provider: 'native',
  competitionFormat: 'singles',
  name: 'Open championship with a longer tournament name',
  resultsMode: 'auto',
  eventDate: '2026-10-03T00:00:00Z',
  isRookie: false,
  challongeState: 'complete',
  syncState: 'synced',
  lastSyncedAt: null,
  liveUntil: null,
  participants: [
    {
      id: 'winner',
      name: alias,
      playerId: null,
      memberPlayerIds: null,
      companyCode: null,
      challongeSeed: 1,
      finalRank: 1,
    },
  ],
  sets: [],
} satisfies TournamentData;
const event = {
  name: 'Autumn club night with a longer event name',
  date: tournament.eventDate,
  canonicalSlug: slug,
  competitionFormat: 'singles',
  structure: 'single_elimination',
  divisions: [],
  brackets: [
    {
      name: tournament.name,
      slug,
      tournamentId: tournament.id,
      division: 'upper',
      stage: 'main',
      roleSource: 'plan',
      finalFieldSize: 2,
      isComplete: true,
      placeSource: 'reported',
      players: [],
    },
  ],
  warnings: [],
} satisfies EventOverviewData;
const diagnostic = 'Synthetic backend diagnostics for the archive lookup';
type ArchiveResponse = 'available' | 'interrupted' | 'withdrawn';

async function setup(page: Page, procedure: string, path: string, data: unknown) {
  const fixture = await mockEvent(page);
  fixture.responses[procedure] = data;
  fixture.responses['public.tournaments'] ??= [];
  let response: ArchiveResponse = 'interrupted';
  let calls = 0;
  let waitForRelease: Promise<void> | undefined;
  await page.route(
    (url) => url.pathname === `/api/trpc/${procedure}`,
    async (route) => {
      ++calls;
      const outcome = response;
      const hold = waitForRelease;
      waitForRelease = undefined;
      if (hold) await hold;
      if (outcome === 'available') return route.fallback();
      const httpStatus = outcome === 'withdrawn' ? 404 : 500;
      const error = {
        error: {
          message: diagnostic,
          code: outcome === 'withdrawn' ? -32004 : -32603,
          data: {
            code: outcome === 'withdrawn' ? 'NOT_FOUND' : 'INTERNAL_SERVER_ERROR',
            httpStatus,
          },
        },
      };
      const batched = new URL(route.request().url()).searchParams.has('batch');
      await route.fulfill({ status: httpStatus, json: batched ? [error] : error });
    },
  );
  return {
    fixture,
    goto: () => page.goto(path),
    calls: () => calls,
    respond(outcome: ArchiveResponse) {
      response = outcome;
    },
    holdNext() {
      let release!: () => void;
      waitForRelease = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

async function reviewRoute(page: Page, info: TestInfo, image: string) {
  await ready(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({ path: info.outputPath(image), fullPage: true });
}

const routes = [
  {
    procedure: 'public.tournaments',
    path: '/tournaments',
    heading: 'Tournaments',
    copy: 'Could not load tournaments.',
    data: [{ ...tournament, nativeEventId: 'archive-event', nativeEventName: event.name }],
    link: event.name,
    href: `/events/${slug}`,
    theme: 'dark',
  },
  {
    procedure: 'public.eventOverview',
    path: `/events/${slug}`,
    heading: event.name,
    copy: 'Could not load this event.',
    data: event,
    link: tournament.name,
    href: `/tournaments/${slug}`,
    theme: 'light',
  },
  {
    procedure: 'public.tournament',
    path: `/tournaments/${slug}`,
    heading: tournament.name,
    copy: 'Could not load this tournament.',
    data: tournament,
    link: 'Event results →',
    href: `/events/${slug}`,
    theme: 'dark',
  },
] as const;

for (const archive of routes) {
  for (const width of [390, 1440]) {
    const theme = width === 390 ? archive.theme : archive.theme === 'dark' ? 'light' : 'dark';
    test(`${archive.procedure} retries and recovers by keyboard at ${width} in ${theme}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      const path = `${archive.path}?from=club#public-results`;
      const network = await setup(page, archive.procedure, path, archive.data);
      await network.goto();

      const main = page.getByRole('main');
      const alert = main.getByRole('alert');
      await expect(alert).toHaveText(archive.copy);
      await expect(main.getByText(diagnostic)).toHaveCount(0);
      const retry = main.getByRole('button', { name: 'Try again' });
      await main.focus();
      await page.keyboard.press('Tab');
      await expect(retry).toBeFocused();
      await reviewRoute(page, info, 'load-error.png');
      await page.evaluate(() => {
        document.body.dataset.retryFixture = 'same-document';
      });

      const initialCalls = network.calls();
      const status = main.getByRole('status');
      const originalStatus = await status.elementHandle();
      const release = network.holdNext();
      try {
        await page.keyboard.press('Enter');
        await expect(status).toHaveText('Trying again…');
        expect(await status.evaluate((node, original) => node === original, originalStatus)).toBe(
          true,
        );
        await expect(retry).toBeFocused();
        await expect(retry).toBeDisabled();
        await expect.poll(network.calls).toBe(initialCalls + 1);
        await page.keyboard.press('Enter');
      } finally {
        release();
      }
      await expect(alert).toHaveText(archive.copy);
      expect(network.calls()).toBe(initialCalls + 2);
      await expect(retry).toBeFocused();
      await expect(retry).toBeEnabled();

      network.respond('available');
      await page.keyboard.press('Enter');
      await expect(main.getByRole('heading', { level: 1, name: archive.heading })).toBeFocused();
      await expect(alert).toHaveCount(0);
      await expect(main.getByRole('link', { name: archive.link, exact: true })).toHaveAttribute(
        'href',
        archive.href,
      );
      await expect(page).toHaveURL(path);
      await expect(page.locator('body')).toHaveAttribute('data-retry-fixture', 'same-document');
      await reviewRoute(page, info, 'recovered.png');
      expect(network.fixture.unexpected).toEqual([]);
    });
  }
}

test('a successful empty archive and a missing event keep distinct states', async ({ page }) => {
  const network = await setup(page, 'public.eventOverview', `/events/${slug}`, null);
  network.respond('available');
  await network.goto();
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: 'Event not found' })).toBeVisible();
  await expect(main.getByRole('alert')).toHaveCount(0);
  await expect(main.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await main.getByRole('link', { name: 'Browse tournaments' }).click();
  await expect(page).toHaveURL('/tournaments');
  await expect(main.getByText('No tournaments registered yet.')).toBeVisible();
  await expect(main.getByRole('alert')).toHaveCount(0);
  expect(network.fixture.unexpected).toEqual([]);
});

test('failed refresh keeps public results visible and a withdrawal clears them', async ({
  context,
  page,
}) => {
  const network = await setup(page, 'public.tournament', `/tournaments/${slug}`, tournament);
  network.respond('available');
  await network.goto();
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: tournament.name })).toBeVisible();
  await expect(main.getByText(alias)).toBeVisible();

  // Expire the query before reconnecting, without reloading the page.
  await page.clock.setFixedTime(new Date('2026-10-04T00:01:00Z'));
  network.respond('interrupted');
  await context.setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
  await context.setOffline(false);
  await expect(main.getByRole('alert')).toContainText('Could not refresh this tournament.');
  await expect(main.getByText(alias)).toBeVisible();

  network.respond('withdrawn');
  const retry = main.getByRole('button', { name: 'Try again' });
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(main.getByRole('heading', { name: 'Tournament not found' })).toBeVisible();
  await expect(main.getByRole('link', { name: 'Browse tournaments' })).toBeFocused();
  await expect(main.getByText(alias)).toHaveCount(0);
  await expect(retry).toHaveCount(0);
  expect(network.fixture.unexpected).toEqual([]);
});
