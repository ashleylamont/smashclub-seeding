import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { TournamentData } from '../src/lib/apiTypes';
import { mockEvent, ready } from './fixtures';

const firstId = '0974a2a7-dcc6-4dd6-8408-e641b934d9b5';
const secondId = 'd8bf58ac-58f3-45e3-a42a-cf17cba422a1';
const firstAlias = 'CoastWithALongTournamentAliasFromWesternSydney';
const secondAlias = 'Syd';
const slug = 'club-finals';
const path = `/tournaments/${slug}`;
const date = '2026-10-03T08:45:00.000Z';
const tournament = {
  id: 'bracket',
  slug,
  provider: 'native',
  competitionFormat: 'singles',
  name: 'Club finals',
  eventDate: date,
  resultsMode: 'auto',
  isRookie: false,
  challongeState: 'complete',
  syncState: 'synced',
  lastSyncedAt: date,
  liveUntil: null,
  participants: [
    {
      id: 'first',
      playerId: firstId,
      memberPlayerIds: null,
      name: firstAlias,
      finalRank: 1,
      challongeSeed: 1,
      companyCode: null,
    },
    {
      id: 'second',
      playerId: secondId,
      memberPlayerIds: null,
      name: secondAlias,
      finalRank: 2,
      challongeSeed: 3,
      companyCode: null,
    },
    {
      id: 'unlinked',
      playerId: null,
      memberPlayerIds: null,
      name: firstAlias,
      finalRank: 3,
      challongeSeed: 2,
      companyCode: null,
    },
  ],
  sets: [
    {
      id: 'championship',
      round: 1,
      identifier: 'Championship',
      resultStage: 'final',
      state: 'complete',
      winner: 1,
      scoresCsv: '3-2',
      unplayedOutcome: null,
      excludedFromRatings: false,
      excludedByResultsMode: false,
      completedAt: date,
      p1ParticipantId: 'first',
      p2ParticipantId: 'second',
      p1Name: firstAlias,
      p2Name: secondAlias,
      p1PlayerId: firstId,
      p2PlayerId: secondId,
    },
    {
      id: 'pool',
      round: 1,
      identifier: 'Pool set',
      resultStage: 'group',
      state: 'complete',
      winner: 1,
      scoresCsv: '2-1',
      unplayedOutcome: null,
      excludedFromRatings: false,
      excludedByResultsMode: false,
      completedAt: date,
      p1ParticipantId: 'unlinked',
      p2ParticipantId: 'second',
      p1Name: firstAlias,
      p2Name: secondAlias,
      p1PlayerId: null,
      p2PlayerId: secondId,
    },
  ],
} satisfies TournamentData;

async function openTournament(page: Page, data: TournamentData) {
  const fixture = await mockEvent(page);
  const previewRequests: string[] = [];
  fixture.responses['public.tournament'] = data;
  fixture.queryResponses.set('public.playerPreview', (input) => {
    const { playerId } = input as { playerId: string };
    previewRequests.push(playerId);
    return {
      profile: {
        name: playerId === firstId ? firstAlias : secondAlias,
        characters: ['mario'],
        rating: { clubRating: 1582, wins: 8, losses: 6, isProvisional: false },
      },
      redirectTo: null,
    };
  });
  await page.route('**/api/live/bracket', (route) =>
    route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' }),
  );
  await page.goto(path);
  await expect(page.getByRole('heading', { name: data.name, exact: true })).toBeVisible();
  return { fixture, previewRequests };
}

async function checkPreview(
  page: Page,
  trigger: Locator,
  name: string,
  id: string,
  touch: boolean,
) {
  if (touch) await trigger.tap();
  else await trigger.press('Enter');
  const dialog = page.getByRole('dialog', { name, exact: true });
  await expect(dialog.getByText('1582', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'View full profile' })).toHaveAttribute(
    'href',
    `/players/${id}`,
  );
  await expect(page).toHaveURL(new RegExp(`${path}$`));
  return dialog;
}

for (const width of [390, 1440])
  test.describe(`${width}px tournament player previews`, () => {
    test.use({ hasTouch: width === 390 });

    for (const theme of ['dark', 'light'] as const)
      test(`opens previews from standings and sets in ${theme}`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
        const { fixture, previewRequests } = await openTournament(page, tournament);
        const standings = page.getByRole('table').first();
        const sets = page.getByRole('region', { name: 'Tournament sets' });
        await expect(
          standings.getByRole('link', { name: firstAlias, exact: true }),
        ).toHaveAttribute('href', `/players/${firstId}`);
        await expect(standings.getByRole('row', { name: /3 Coast/ }).first()).toBeVisible();
        await expect(
          sets
            .getByRole('row', { name: /Pool set/ })
            .getByRole('button', { name: `Preview ${firstAlias}` }),
        ).toHaveCount(0);
        expect(previewRequests).toEqual([]);
        const firstPreview = standings.getByRole('button', {
          name: `Preview ${firstAlias}`,
          exact: true,
        });
        await expect(firstPreview).toBeVisible();
        await ready(page);
        await page.screenshot({ path: testInfo.outputPath('tournament-standings.png') });
        const dialog = await checkPreview(page, firstPreview, firstAlias, firstId, width === 390);
        await ready(page);
        await page.screenshot({ path: testInfo.outputPath('tournament-preview.png') });
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
        await expect(firstPreview).toBeFocused();

        const stage = page.getByRole('combobox', { name: 'Filter sets by stage' });
        await stage.press('Enter');
        await page.getByRole('option', { name: 'Bracket' }).click();
        await expect(sets.getByText('Pool set', { exact: true })).toHaveCount(0);
        const secondPreview = sets.getByRole('button', {
          name: `Preview ${secondAlias}`,
          exact: true,
        });
        await expect(secondPreview).toBeVisible();
        await sets
          .getByRole('button', { name: `Preview ${firstAlias}`, exact: true })
          .scrollIntoViewIfNeeded();
        if (width === 390) {
          const target = await secondPreview.boundingBox();
          expect(target?.width ?? 0).toBeGreaterThanOrEqual(44);
          expect(target?.height ?? 0).toBeGreaterThanOrEqual(44);
        }
        await ready(page);
        await page.screenshot({ path: testInfo.outputPath('tournament-sets.png') });
        const otherDialog = await checkPreview(
          page,
          secondPreview,
          secondAlias,
          secondId,
          width === 390,
        );
        await page.keyboard.press('Escape');
        await expect(otherDialog).toBeHidden();
        await expect(secondPreview).toBeFocused();
        await expect(sets.getByText('Pool set', { exact: true })).toHaveCount(0);
        await expect(sets.getByText('Championship', { exact: true })).toBeVisible();
        expect(previewRequests).toEqual([firstId, secondId]);
        expect(fixture.unexpected).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
        expect(
          (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
            .violations,
        ).toEqual([]);
      });
  });

test('keeps live participants and recent results on the same tournament', async ({
  page,
}, testInfo) => {
  const { fixture, previewRequests } = await openTournament(page, {
    ...tournament,
    provider: 'challonge',
    challongeState: 'underway',
    liveUntil: '2026-10-05T00:00:00.000Z',
  });
  const participants = page.getByRole('table').first();
  const feed = page.locator('.live-feed');
  await expect(participants.getByRole('link', { name: firstAlias, exact: true })).toBeVisible();
  await expect(feed.getByRole('heading', { name: /Recent results/ })).toBeVisible();
  expect(previewRequests).toEqual([]);
  const participant = participants.getByRole('button', {
    name: `Preview ${firstAlias}`,
    exact: true,
  });
  await checkPreview(page, participant, firstAlias, firstId, false);
  await page.keyboard.press('Escape');
  await expect(participant).toBeFocused();
  const recentSet = feed.getByRole('button', { name: `Preview ${firstAlias}`, exact: true });
  await checkPreview(page, recentSet, firstAlias, firstId, false);
  await page.keyboard.press('Escape');
  await expect(recentSet).toBeFocused();
  await ready(page);
  await page.screenshot({ path: testInfo.outputPath('tournament-live.png') });
  expect(previewRequests.every((playerId) => playerId === firstId)).toBe(true);
  expect(fixture.unexpected).toEqual([]);
});

test('keeps imported team labels and empty set sides outside player previews', async ({ page }) => {
  const team = 'Coast / Syd';
  const [entry] = tournament.participants;
  const { fixture, previewRequests } = await openTournament(page, {
    ...tournament,
    provider: 'challonge',
    competitionFormat: 'doubles',
    participants: [{ ...entry!, name: team, memberPlayerIds: [firstId, secondId] }],
    sets: [
      {
        ...tournament.sets[0]!,
        p1Name: team,
        p2Name: null,
        p2ParticipantId: null,
      },
    ],
  });
  const standings = page.getByRole('table').first();
  await expect(standings.getByText(team, { exact: true })).toBeVisible();
  await expect(standings.getByRole('link', { name: team })).toHaveCount(0);
  const sets = page.getByRole('region', { name: 'Tournament sets' });
  await expect(sets.getByText(team, { exact: true })).toBeVisible();
  await expect(sets.getByText('TBD')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Preview (?:Coast|Syd|TBD)/ })).toHaveCount(0);
  expect(previewRequests).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test('keeps set names plain when recorded player IDs disagree with the participants', async ({
  page,
}) => {
  const { previewRequests } = await openTournament(page, {
    ...tournament,
    provider: 'challonge',
    sets: [
      {
        ...tournament.sets[0]!,
        p1ParticipantId: 'second',
        p1Name: secondAlias,
        p2ParticipantId: null,
        p2Name: null,
        p2PlayerId: null,
      },
      {
        ...tournament.sets[1]!,
        p1PlayerId: firstId,
      },
    ],
  });
  const sets = page.getByRole('region', { name: 'Tournament sets' });
  const corrected = sets.getByRole('row', { name: /Championship/ });
  await expect(corrected.getByText(secondAlias, { exact: true })).toBeVisible();
  await expect(corrected.getByRole('button', { name: `Preview ${secondAlias}` })).toHaveCount(0);
  const unlinked = sets.getByRole('row', { name: /Pool set/ });
  await expect(unlinked.getByText(firstAlias, { exact: true })).toBeVisible();
  await expect(unlinked.getByRole('button', { name: `Preview ${firstAlias}` })).toHaveCount(0);
  await expect(unlinked.getByRole('button', { name: `Preview ${secondAlias}` })).toBeVisible();
  expect(previewRequests).toEqual([]);
});

test('keeps explicit team labels plain in an older singles-format import', async ({ page }) => {
  const team = 'Coast / Syd';
  const { previewRequests } = await openTournament(page, {
    ...tournament,
    provider: 'challonge',
    participants: [
      { ...tournament.participants[0]!, name: team, memberPlayerIds: [firstId, secondId] },
      tournament.participants[1]!,
    ],
    sets: [{ ...tournament.sets[0]!, p1Name: team }],
  });
  const standings = page.getByRole('table').first();
  const sets = page.getByRole('region', { name: 'Tournament sets' });
  await expect(standings.getByText(team, { exact: true })).toBeVisible();
  await expect(sets.getByText(team, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: `Preview ${team}` })).toHaveCount(0);
  await expect(standings.getByRole('link', { name: team })).toHaveCount(0);
  await expect(standings.getByRole('button', { name: `Preview ${secondAlias}` })).toBeVisible();
  expect(previewRequests).toEqual([]);
});
