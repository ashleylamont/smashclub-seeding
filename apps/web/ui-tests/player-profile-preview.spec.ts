import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { EventOverviewData } from '../src/lib/apiTypes';
import { mockEvent, ready } from './fixtures';

const featured = '00000000-0000-4000-8000-000000000001';
const newcomer = '00000000-0000-4000-8000-000000000002';
const moved = '00000000-0000-4000-8000-000000000003';
const longAlias = 'Alex & Co with a very long tournament alias from Western Sydney';
const players = [
  { playerId: featured, name: longAlias },
  { playerId: newcomer, name: 'New player' },
  { playerId: moved, name: 'Former alias' },
  { playerId: null, name: 'Visiting player' },
].map((player, index) => ({
  ...player,
  entryKey: `entry-${index}`,
  place: index + 1,
  placeSource: 'reported' as const,
  inFinalStage: true,
  wins: 2,
  losses: 1,
  poolWins: 2,
  poolLosses: 0,
  bracketWins: 0,
  bracketLosses: 1,
  provisional: false,
  tournamentId: 'club-finals',
}));
const eventOverview = {
  name: 'Autumn Club Night',
  date: '2026-10-02T08:30:00.000Z',
  canonicalSlug: 'club-finals',
  competitionFormat: 'singles',
  structure: 'pools_finals',
  divisions: [{ division: 'upper', players, notice: null }],
  brackets: [
    {
      name: 'Club championship',
      slug: 'club-finals',
      tournamentId: 'club-finals',
      division: 'upper',
      stage: 'main',
      roleSource: 'plan',
      finalFieldSize: players.length,
      isComplete: true,
      placeSource: 'reported',
      players,
    },
  ],
  warnings: [],
} satisfies EventOverviewData;

async function openStandings(page: Page) {
  const fixture = await mockEvent(page);
  const previewIds: string[] = [];
  fixture.responses['public.eventOverview'] = eventOverview;
  fixture.queryResponses.set('public.playerPreview', (input) => {
    const { playerId } = input as { playerId: string };
    previewIds.push(playerId);
    if (playerId === featured)
      return {
        profile: {
          name: longAlias,
          characters: ['mario', 'kirby'],
          rating: { clubRating: 1596.25, wins: 24, losses: 15, isProvisional: true },
        },
        redirectTo: null,
      };
    if (playerId === moved) return { profile: null, redirectTo: featured };
    return { profile: { name: 'New player', characters: [], rating: null }, redirectTo: null };
  });
  await page.goto('/events/club-finals');
  const standings = page.getByRole('region', { name: 'Open standings' });
  await expect(standings).toBeVisible();
  return { fixture, standings, previewIds };
}

for (const width of [390, 1440])
  test.describe(`${width}px player previews`, () => {
    test.use({ hasTouch: width === 390 });

    for (const theme of ['dark', 'light'] as const)
      test(`opens a current profile without losing the archived result in ${theme}`, async ({
        page,
      }, testInfo) => {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
        const { fixture, standings, previewIds } = await openStandings(page);
        await ready(page);
        await page.screenshot({ path: testInfo.outputPath('standings.png'), fullPage: true });
        const row = standings.getByRole('row', { name: new RegExp(longAlias) });
        await expect(row.getByRole('link', { name: longAlias })).toHaveAttribute(
          'href',
          `/players/${featured}`,
        );
        expect(previewIds).toEqual([]);
        const preview = row.getByRole('button', { name: `Preview ${longAlias}` });
        if (width === 390) await preview.tap({ timeout: 3000 });
        else await preview.press('Enter', { timeout: 3000 });

        const dialog = page.getByRole('dialog', { name: longAlias });
        await expect(dialog.getByText('1596', { exact: true })).toBeVisible();
        await expect(dialog.getByText('24–15', { exact: true })).toBeVisible();
        await expect(dialog.getByText('Rated sets (W–L)')).toBeVisible();
        await expect(dialog.getByText('Provisional')).toBeVisible();
        await expect(dialog.getByRole('img', { name: 'Mains Mario' })).toBeVisible();
        await expect(dialog.getByRole('img', { name: 'Kirby' })).toBeVisible();
        await expect(dialog.getByRole('link', { name: 'View full profile' })).toHaveAttribute(
          'href',
          `/players/${featured}`,
        );
        expect(previewIds).toEqual([featured]);
        expect(fixture.unexpected).not.toContain('public.player');
        await expect(page).toHaveURL(/\/events\/club-finals$/);
        await ready(page);
        await page.screenshot({ path: testInfo.outputPath('profile-preview.png') });
        expect(
          (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
            .violations,
        ).toEqual([]);
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
        await expect(preview).toBeFocused();
        await expect(standings.getByRole('cell', { name: 'Visiting player' })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      });
  });

test('shows no fabricated rating for a new player and follows a prior profile link', async ({
  page,
}) => {
  const { standings, previewIds } = await openStandings(page);
  await standings.getByRole('button', { name: 'Preview New player' }).press('Enter');
  const fresh = page.getByRole('dialog', { name: 'New player' });
  await expect(fresh.getByText('Unrated')).toBeVisible();
  await expect(fresh.getByText('No rated sets')).toBeVisible();
  await expect(fresh.getByText('No mains listed')).toBeVisible();
  await page.keyboard.press('Escape');
  await standings.getByRole('button', { name: 'Preview Former alias' }).press('Enter');
  const archived = page.getByRole('dialog', { name: 'Former alias' });
  await expect(archived.getByRole('link', { name: 'View full profile' })).toHaveAttribute(
    'href',
    `/players/${featured}`,
  );
  expect(previewIds).toEqual([newcomer, moved]);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'View bracket standings' }).press('Enter');
  const bracket = page.getByRole('region', { name: 'Club championship standings' });
  const bracketPreview = bracket.getByRole('button', { name: `Preview ${longAlias}` });
  await bracketPreview.press('Enter');
  await expect(page.getByRole('dialog', { name: longAlias })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(bracketPreview).toBeFocused();
});

test('keeps the archive and full profile link available while retrying a failed preview', async ({
  page,
}) => {
  const { standings } = await openStandings(page);
  const previewRequest = /\/api\/trpc\/public\.playerPreview\?/;
  await page.route(previewRequest, (route) => route.abort(), { times: 1 });
  await standings.getByRole('button', { name: `Preview ${longAlias}` }).press('Enter');
  const dialog = page.getByRole('dialog', { name: longAlias });
  await expect(dialog.getByRole('alert')).toContainText('could not be loaded');
  await expect(dialog.getByRole('link', { name: 'View full profile' })).toHaveAttribute(
    'href',
    `/players/${featured}`,
  );
  await dialog.getByRole('button', { name: 'Retry preview' }).press('Enter');
  await expect(dialog.getByText('1596', { exact: true })).toBeVisible();
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await expect(page).toHaveURL(/\/events\/club-finals$/);
});
