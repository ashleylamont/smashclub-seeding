import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mockEvent, PLAN_ID, PLAYER_NAME, ready } from './fixtures';

const providerIdentifier = 'M700351 · Replay 2';
const upperLabel = `upper main · ${providerIdentifier}`;
const upperCaption = `Upper Championship · ${providerIdentifier}`;
const lowerLabel = 'lower consolation · 17';
const lowerCaption = 'Lower Consolation · 17';
const customLabel = 'Provider stage · Match 19';

async function fixtureWithLinkedFinals(page: Page) {
  const fixture = await mockEvent(page, { idle: true });
  const base = fixture.snapshot.matches.find((match) => match.status === 'complete')!;
  const upper = {
    ...base,
    id: 'linked-upper',
    sourceSetId: 'source-upper',
    sourceKey: 'set:source-upper',
    division: 'upper',
    stage: 'main',
    poolIndex: null,
    label: upperLabel,
    nativeBracketId: null,
    stationId: null,
    player1Name: PLAYER_NAME,
    player2Name: 'Jordan with a long tournament alias',
    outcome: 'played',
    winnerId: base.player1Id,
    score1: 2,
    score2: 1,
    resultUpdatedAt: '2026-10-04T00:04:00Z',
  };
  const lower = {
    ...upper,
    id: 'linked-lower',
    sourceSetId: 'source-lower',
    sourceKey: 'set:source-lower',
    division: 'lower',
    stage: 'consolation',
    label: lowerLabel,
    resultUpdatedAt: '2026-10-04T00:03:00Z',
  };
  const custom = {
    ...upper,
    id: 'linked-custom',
    sourceSetId: 'source-custom',
    sourceKey: 'set:source-custom',
    label: customLabel,
    resultUpdatedAt: '2026-10-04T00:02:00Z',
  };
  const reportable = {
    ...upper,
    id: 'linked-reportable',
    sourceSetId: 'source-reportable',
    sourceKey: 'set:source-reportable',
    label: 'upper main · M700352',
    status: 'ready',
    outcome: null,
    winnerId: null,
    score1: null,
    score2: null,
    resultUpdatedAt: null,
  };
  Object.assign(fixture.snapshot.plan, { bracketMode: 'challonge' });
  Object.assign(fixture.snapshot, {
    matches: [upper, lower, custom, reportable],
    stationQueues: [],
    poolRounds: [],
    brackets: [
      { division: 'upper', stage: 'main', slug: 'fixture-upper' },
      { division: 'lower', stage: 'consolation', slug: 'fixture-lower' },
    ],
  });
  fixture.responses['eventOps.guests.matches'] = { ...fixture.snapshot, reports: [] };
  return { ...fixture, upper };
}

async function accessible(page: Page, selector: string) {
  await ready(page);
  expect(
    (
      await new AxeBuilder({ page })
        .include(selector)
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const theme of ['dark', 'light'] as const) {
  for (const width of [390, 1440]) {
    test(`${theme} ${width}px linked player captions preserve context, scores and stored-label search`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      const guest = width === 1440;
      await page.addInitScript(
        ({ theme, guest, planId }) => {
          localStorage.setItem('smashclub:theme', theme);
          if (guest)
            localStorage.setItem(
              `nemesis:guest:${planId}`,
              JSON.stringify({
                sessionToken: 'linked-caption-guest-pass'.repeat(2),
                expiresAt: null,
              }),
            );
        },
        { theme, guest, planId: PLAN_ID },
      );
      const { upper, unexpected } = await fixtureWithLinkedFinals(page);
      await page.goto(`/${guest ? 'guest' : 'play'}/${PLAN_ID}?player=${upper.player1Id}`);
      const matches = page.locator('article.ops-match');
      const upperCard = matches.filter({ hasText: upperCaption });
      await expect(upperCard.getByText(upperCaption, { exact: true })).toBeVisible();
      await expect(upperCard).toContainText('Confirmed result: 2 – 1');
      await expect(upperCard).not.toContainText(upperLabel);
      await expect(matches.getByText(lowerCaption, { exact: true })).toBeVisible();
      await expect(matches.getByText(`upper · ${customLabel}`, { exact: true })).toBeVisible();
      await expect(page.getByRole('complementary', { name: 'Your progress' })).toContainText(
        'Upper Championship · M700352',
      );
      const reportable = matches.filter({ hasText: 'Upper Championship · M700352' });
      await expect(reportable.getByRole('spinbutton')).toHaveCount(guest ? 2 : 0);
      const results = page.getByRole('region', { name: 'Results', exact: true });
      const metadata = results.locator('.event-match-meta').filter({ hasText: providerIdentifier });
      await expect(metadata.locator('span')).toHaveText(['Upper Championship', providerIdentifier]);
      await page.getByRole('link', { name: 'Results', exact: true }).press('Enter');
      await expect(page).toHaveURL(/#event-results$/);
      await expect(metadata).toBeVisible();
      await accessible(page, '.player-event-hub');
      await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
      await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
      await page.screenshot({ path: testInfo.outputPath('linked-player-hub.png'), fullPage: true });

      await page.getByRole('button', { name: 'Match filters', exact: true }).press('Enter');
      await page.getByRole('textbox', { name: 'Search matches' }).fill(upperLabel);
      await expect(matches).toHaveCount(1);
      await expect(upperCard).toBeVisible();
      expect(unexpected).toEqual([]);
    });
  }
}

for (const width of [1280, 1920]) {
  test(`${width}px linked OBS uses the context once and keeps the original identifier`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: (width * 9) / 16 });
    const { unexpected } = await fixtureWithLinkedFinals(page);
    await page.goto(`/overlay/${PLAN_ID}?presentation=gameplay&controls=0`);
    const rail = page.getByRole('region', { name: 'Recent resolved sets', exact: true });
    await expect(rail.getByText(upperCaption, { exact: true })).toBeVisible();
    await expect(rail.getByText(lowerCaption, { exact: true })).toBeVisible();
    await expect(rail).not.toContainText(upperLabel);
    await expect(rail).not.toContainText(lowerLabel);
    await expect(page.getByRole('region', { name: 'Transparent game capture area' })).toBeVisible();
    await accessible(page, '.broadcast-recent-sets');
    await page.screenshot({
      path: testInfo.outputPath('linked-obs-gameplay.png'),
      omitBackground: true,
    });

    await page.goto(`/overlay/${PLAN_ID}?presentation=progress&controls=0`);
    const upper = page.getByRole('table', { name: 'Linked Upper Championship bracket' });
    await expect(upper.getByRole('cell', { name: providerIdentifier, exact: true })).toBeVisible();
    await expect(upper.getByRole('cell', { name: customLabel, exact: true })).toBeVisible();
    await expect(upper.getByRole('cell', { name: '2–1', exact: true })).toHaveCount(2);
    await expect(upper).not.toContainText(upperLabel);
    await accessible(page, '.broadcast-intermission');
    await page.screenshot({ path: testInfo.outputPath('linked-obs-progress.png') });
    await page.keyboard.press('ArrowRight');
    const lower = page.getByRole('table', { name: 'Linked Lower Consolation bracket' });
    await expect(lower.getByRole('cell', { name: '17', exact: true })).toBeVisible();
    await expect(lower).not.toContainText(lowerLabel);
    await page.screenshot({ path: testInfo.outputPath('linked-obs-consolation.png') });
    expect(unexpected).toEqual([]);
  });
}
