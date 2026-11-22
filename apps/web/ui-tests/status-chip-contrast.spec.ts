import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { AdminClaim, RecapData, TournamentData } from '../src/lib/apiTypes';
import { mockEvent, ready } from './fixtures';

const alias = 'Returning player with a long tournament alias';
const claim: AdminClaim = {
  id: '054c6917-4a03-48a7-ad80-44884a6107bf',
  playerId: 'ea5b692f-2cd3-49c4-a88d-a7d17fdb3f37',
  canonicalName: alias,
  displayName: alias,
  playerName: alias,
  userName: 'Synthetic account',
  userEmail: 'claimant@example.test',
  note: 'Synthetic evidence for review.',
  jevReview: null,
  status: 'pending',
  autoApproved: false,
  createdAt: '2026-10-03T00:00:00Z',
};
const tournament: TournamentData = {
  id: 'status-chip-tournament',
  slug: 'status-chip-tournament',
  provider: 'native',
  competitionFormat: 'singles',
  name: 'Rookie tournament with a long event name',
  resultsMode: 'auto',
  eventDate: '2026-10-03T00:00:00Z',
  isRookie: true,
  challongeState: 'complete',
  syncState: 'synced',
  lastSyncedAt: null,
  liveUntil: null,
  participants: [],
  sets: [],
};
const recap: RecapData = {
  eventKey: tournament.slug,
  slug: tournament.slug,
  name: tournament.name,
  competitionFormat: 'singles',
  isComplete: false,
  isAbandoned: false,
  entrants: 8,
  setsPlayed: 4,
  tournaments: [{ ...tournament }],
  facts: [],
  highlights: [],
  coverage: {
    unsyncedBrackets: 0,
    unresolvedEntrants: 0,
    unlinkedPlayedSets: 0,
    ignoredGroupSets: 0,
  },
};
const themes = [
  { label: 'system light', system: 'light', selected: null },
  { label: 'explicit light', system: 'dark', selected: 'light' },
  { label: 'system dark', system: 'dark', selected: null },
  { label: 'explicit dark', system: 'light', selected: 'dark' },
] as const;

async function inspect(page: Page, testInfo: TestInfo, name: string) {
  await ready(page);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
}

for (const { label, system, selected } of themes)
  for (const width of [390, 1440])
    test.describe(`status chips at ${width}px in ${label}`, () => {
      test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await page.emulateMedia({ colorScheme: system });
        if (selected)
          await page.addInitScript(
            (theme) => localStorage.setItem('smashclub:theme', theme),
            selected,
          );
      });
      for (const surface of ['gallery', 'claims', 'tournament', 'recap'] as const)
        test(surface, async ({ page }, testInfo) => {
          const fixture = await mockEvent(page, { role: 'admin' });
          fixture.responses['admin.claims'] = [
            claim,
            { ...claim, id: 'approved-claim', status: 'approved' },
          ];
          fixture.responses['public.tournament'] = tournament;
          fixture.responses['public.recap'] = recap;

          if (surface === 'gallery') {
            await page.goto('/ui');
            await page.getByRole('tab', { name: 'Foundations' }).press('Enter');
            await expect(page.locator('.chip-success')).toHaveText('approved');
            await expect(page.locator('.chip-warning')).toHaveText('pending');
            await expect(page.locator('.chip-danger')).toHaveText('rejected');
          } else if (surface === 'claims') {
            await page.goto('/admin/players');
            const claims = page.getByRole('region', { name: 'Player claims', exact: true });
            await expect(claims.locator('.chip-warning')).toHaveText('pending');
            await expect(claims.locator('.chip-success')).toHaveText('approved');
            await claims.focus();
            await expect(claims).toBeFocused();
            if (width === 390) {
              await claims.press('ArrowRight');
              await expect
                .poll(() => claims.evaluate((element) => element.scrollLeft))
                .toBeGreaterThan(0);
            }
            await claims.getByRole('button', { name: 'Approve', exact: true }).focus();
            await expect(
              claims.getByRole('button', { name: 'Approve', exact: true }),
            ).toBeInViewport();
          } else if (surface === 'tournament') {
            await page.goto(`/tournaments/${tournament.slug}`);
            await expect(page.locator('.chip-warning')).toHaveText('rookie');
          } else {
            await page.goto(`/recaps/${tournament.slug}`);
            await expect(page.locator('.recap-progress-chip')).toHaveText('still in progress');
          }
          await inspect(page, testInfo, surface);
          expect(fixture.unexpected).toEqual([]);
          expect(fixture.submissions).toEqual([]);
        });
    });
