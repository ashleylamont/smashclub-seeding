import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { PublicEventNight } from '../src/lib/publicEvents';
import { chooseOption } from '../test-support/controls';
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

for (const width of [390, 1440]) {
  test.describe(`${width}px finished player previews`, () => {
    test.use({ hasTouch: width === 390 });

    for (const theme of ['dark', 'light'] as const) {
      test(`uses verified native match sides in ${theme}`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
        const { snapshot, responses, queryResponses, submissions, unexpected } = await mockEvent(
          page,
          { bracket: true },
        );
        const played = snapshot.matches.find(
          (match) => match.status === 'complete' && match.outcome === 'played',
        )!;
        if (played.nativeBracketId !== null) throw new Error('Expected a recorded pool match.');
        const linked = snapshot.entrants.find((entrant) => entrant.id === played.player1Id)!;
        const merged = snapshot.entrants.find(({ name }) => name === 'Peach')!;
        const team = snapshot.entrants.find(({ name }) => name === 'Ice C')!;
        const newProfile = 'f014a44e-78d7-44b8-a436-38fe88216f28';
        const placeholder = snapshot.entrants.find((entrant) => entrant.id === played.player2Id)!;
        Object.assign(linked, { name: PLAYER_NAME, memberPlayerIds: [linked.id] });
        Object.assign(placeholder, { name: 'Player', memberPlayerIds: [placeholder.id] });
        Object.assign(team, { name: 'Side Quest', memberPlayerIds: [linked.id, merged.id] });
        const semi = snapshot.matches.find(({ id }) => id === 'fixture-semi-b')!;
        const bye = snapshot.matches.find(({ id }) => id === 'fixture-semi-a')!;
        const legacyLabel = 'Former alias without verified identity';
        const missingRoster = 'Visiting player';
        Object.assign(snapshot.plan, finished, { liveOwned: true });
        expect(snapshot.plan.resultsSlug).toBeNull();
        expect(snapshot.plan.historicalResultsSlug).toBeNull();
        Object.assign(played, {
          player1Name: linked.name,
          player1MemberIds: [linked.id],
          player2Name: placeholder.name,
          player2MemberIds: [placeholder.id],
        });
        Object.assign(semi, {
          status: 'complete',
          outcome: 'played',
          winnerId: merged.id,
          score1: 2,
          score2: 1,
          player2Id: team.id,
          player2Name: team.name,
          player2MemberIds: [linked.id, merged.id],
        });
        const unverified = {
          ...played,
          id: 'fixture-unverified-played',
          label: 'Unverified pairing',
          player1Name: legacyLabel,
          player2Id: '71cbceee-c5d5-411e-8e7f-2029899167dc',
          player2Name: missingRoster,
        };
        snapshot.matches = [played, unverified, semi, bye];
        snapshot.placements = [];
        snapshot.prizes = [];
        responses['eventOps.publicEvents'] = [finished];
        const previewIds: string[] = [];
        queryResponses.set('public.playerPreview', (input) => {
          const { playerId } = input as { playerId: string };
          previewIds.push(playerId);
          return playerId === merged.id
            ? { profile: null, redirectTo: newProfile }
            : {
                profile: {
                  name: linked.name,
                  characters: ['mario'],
                  rating: { clubRating: 1560, wins: 9, losses: 5, isProvisional: false },
                },
                redirectTo: null,
              };
        });

        await enterArchive(page);
        const results = page.getByRole('region', { name: 'Results', exact: true });
        await expect(results).toBeFocused();
        const card = results.getByRole('article').filter({ hasText: played.label });
        await expect(card.locator('.event-contender strong')).toHaveText(['2', '0']);
        await expect(card.getByText(placeholder.name, { exact: true })).toBeVisible();
        await expect(results.getByText(legacyLabel, { exact: true })).toBeVisible();
        await expect(results.getByText(missingRoster, { exact: true })).toBeVisible();
        const bracket = page.locator(`[data-match-id="${semi.id}"]`);
        await expect(bracket.getByText(team.name, { exact: true })).toBeVisible();
        await expect(page.locator(`[data-match-id="${bye.id}"]`).getByRole('button')).toHaveCount(
          0,
        );
        for (const name of [placeholder.name, legacyLabel, missingRoster, team.name]) {
          await expect(
            page.getByRole('button', { name: `Preview ${name}`, exact: true }),
          ).toHaveCount(0);
        }
        expect(previewIds).toEqual([]);
        const trigger = card.getByRole('button', { name: `Preview ${linked.name}`, exact: true });
        await expect(trigger).toBeVisible();
        if (width === 390) await trigger.tap();
        else await trigger.press('Enter');
        const dialog = page.getByRole('dialog', { name: linked.name, exact: true });
        await expect(dialog.getByText('1560', { exact: true })).toBeVisible();
        await expect(dialog.getByRole('link', { name: 'View full profile' })).toHaveAttribute(
          'href',
          `/players/${linked.id}`,
        );
        await ready(page);
        await page.screenshot({ path: testInfo.outputPath('recorded-player-preview.png') });
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
        await expect(trigger).toBeFocused();

        const moved = bracket.getByRole('button', { name: `Preview ${merged.name}`, exact: true });
        await moved.press('Enter');
        const movedDialog = page.getByRole('dialog', { name: merged.name, exact: true });
        await expect(movedDialog.getByText('This profile has moved.')).toBeVisible();
        await expect(movedDialog.getByRole('link', { name: 'View full profile' })).toHaveAttribute(
          'href',
          `/players/${newProfile}`,
        );
        await page.keyboard.press('Escape');
        await expect(moved).toBeFocused();
        expect(previewIds).toEqual([linked.id, merged.id]);

        await chooseOption(page.getByLabel('Match view', { exact: true }), 'results');
        const history = page.getByRole('region', { name: 'Match history', exact: true });
        const historyCard = history.locator(`[data-player-match-id="${played.id}"]`);
        await expect(
          historyCard.getByRole('button', { name: `Preview ${linked.name}`, exact: true }),
        ).toBeVisible();
        await expect(page.getByRole('spinbutton')).toHaveCount(0);
        await expect(page).toHaveURL(`/play/${PLAN_ID}#event-archive`);
        await reviewRoute(page, testInfo, 'finished-match-history');

        // Legacy/adopted native metadata must not make these same names actionable.
        Object.assign(snapshot.plan, { liveOwned: false, historicalResultsSlug: 'linked-history' });
        await page.reload();
        await expect(card.getByText(linked.name, { exact: true })).toBeVisible();
        await expect(results.getByRole('button', { name: `Preview ${linked.name}` })).toHaveCount(
          0,
        );
        expect(previewIds).toEqual([linked.id, merged.id]);
        expect(submissions).toEqual([]);
        expect(unexpected).toEqual([]);
      });
    }
  });
}
