import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Locator } from '@playwright/test';
import { mockEvent, PLAN_ID, PLAYER_NAME, ready } from './fixtures';

async function expectBelowTabs(target: Locator, tabs: Locator) {
  await expect(target).toBeInViewport({ ratio: 1 });
  await expect
    .poll(async () => {
      const [targetBounds, tabBounds] = await Promise.all([
        target.boundingBox(),
        tabs.boundingBox(),
      ]);
      return Math.round(targetBounds!.y - tabBounds!.y - tabBounds!.height);
    })
    .toBeGreaterThanOrEqual(0);
}

for (const theme of ['dark', 'light'] as const) {
  for (const width of [390, 1440]) {
    test(`workspace tab activation reveals the new panel at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      const phone = width === 390;
      await page.setViewportSize({ width, height: phone ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const { overview, responses, unexpected, submissions, starts } = await mockEvent(page, {
        role: phone ? 'player' : 'admin',
      });
      const playing = overview.matches.find(
        (match) => match.status === 'playing' && match.player1Name === PLAYER_NAME,
      )!;
      const station = overview.stations[1]!;
      const path = phone ? `/operate/${PLAN_ID}?` : `/admin/event-operations?plan=${PLAN_ID}&`;
      responses['eventOps.attendeeRoster'] = {
        attendees: overview.entrants.map((entrant) => ({
          playerId: entrant.id,
          publicAlias: entrant.id === playing.player1Id ? PLAYER_NAME : entrant.name,
          canonicalName: entrant.name,
          rawInput: entrant.name,
          division: null,
        })),
        companies: [],
      };
      overview.entrants.find((entrant) => entrant.id === playing.player1Id)!.name = PLAYER_NAME;
      await page.goto(`${path}view=run&station=${station.id}`);
      const tabs = page.getByRole('tablist', { name: 'Event workspace' });
      const runTab = tabs.getByRole('tab', { name: 'Run matches' });
      const playersTab = tabs.getByRole('tab', { name: 'Players' });
      const run = page.getByRole('tabpanel', { name: 'Run matches' });
      const players = page.getByRole('tabpanel', { name: 'Players' });
      const finder = players.getByRole('heading', { name: 'Find a player' });
      const search = players.getByRole('searchbox', { name: 'Player name' });

      await run.getByRole('button', { name: 'Finish match', exact: true }).first().click();
      const draft = run.getByLabel(PLAYER_NAME, { exact: true });
      await draft.fill('2');
      await ready(page);
      await runTab.evaluate((tab) => tab.focus({ preventScroll: true }));
      await run
        .getByRole('heading', { name: 'Score submissions' })
        .evaluate((heading) => heading.scrollIntoView({ block: 'center' }));
      await expect(tabs).toBeInViewport();
      const scrolled = await page.evaluate(() => scrollY);
      expect(scrolled).toBeGreaterThan(500);

      await page.keyboard.press('ArrowRight');
      await expect(playersTab).toBeFocused();
      await expect(runTab).toHaveAttribute('aria-selected', 'true');
      await expect(players).toBeHidden();
      expect(await page.evaluate(() => scrollY)).toBe(scrolled);

      await page.keyboard.press('Enter');
      await expect(playersTab).toHaveAttribute('aria-selected', 'true');
      await expect(playersTab).toBeFocused();
      await expect(page).toHaveURL(`${path}view=players&station=${station.id}`);
      await ready(page);
      await page.screenshot({ path: testInfo.outputPath('players-after-keyboard-tab.png') });
      await expectBelowTabs(finder, tabs);
      await expectBelowTabs(search, tabs);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
          .violations,
      ).toEqual([]);

      await page.keyboard.press('Tab');
      await expect(players).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(search).toBeFocused();
      await search.fill(PLAYER_NAME);
      await players.getByRole('button', { name: new RegExp(PLAYER_NAME) }).click();
      await expect(players.getByRole('heading', { name: PLAYER_NAME, exact: true })).toBeVisible();
      await players.getByRole('button', { name: 'Open current match' }).click();
      await expect(run.locator('#match-desk')).toBeFocused();
      await expect(draft).toHaveValue('2');
      await expect(run.locator('article.ops-match')).toHaveCount(1);

      await run
        .getByRole('heading', { name: 'Score submissions' })
        .evaluate((heading) => heading.scrollIntoView({ block: 'center' }));
      await playersTab.click();
      await expectBelowTabs(finder, tabs);
      await expect(search).toHaveValue(PLAYER_NAME);
      await expect(
        players.getByRole('heading', { name: PLAYER_NAME, exact: true }),
      ).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath('players-after-pointer-tab.png') });
      expect(submissions).toEqual([]);
      expect(starts).toEqual([]);
      expect(unexpected).toEqual([]);
    });
  }
}

test('workspace deep links keep their station, anchor and history entries', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { overview, unexpected } = await mockEvent(page, { role: 'player' });
  const station = overview.stations[1]!;
  const path = `/operate/${PLAN_ID}`;
  const broadcastUrl = `${path}?view=broadcast&station=${station.id}`;
  const playersUrl = `${path}?view=players&station=${station.id}`;
  const attendanceUrl = `${playersUrl}#attendee-list`;
  const eventHeading = page.getByRole('heading', { name: overview.plan.name, exact: true });
  const broadcast = page.getByRole('tabpanel', { name: 'Broadcast' });
  const players = page.getByRole('tabpanel', { name: 'Players' });

  await page.goto(broadcastUrl);
  await expect(broadcast.getByRole('combobox', { name: 'Station' })).toContainText(station.name);
  await expect(eventHeading).toBeInViewport();
  await page.getByRole('tab', { name: 'Players' }).click();
  const finder = players.getByRole('heading', { name: 'Find a player' });
  const copy = players.getByRole('button', { name: 'Copy names' });
  await expect(finder).toBeInViewport();
  await page.evaluate(() => {
    window.location.hash = 'attendee-list';
  });
  await expect(page).toHaveURL(attendanceUrl);
  await expect(copy).toBeInViewport();

  await page.goBack();
  await expect(page).toHaveURL(playersUrl);
  await page.goBack();
  await expect(page).toHaveURL(broadcastUrl);
  await expect(broadcast.getByRole('combobox', { name: 'Station' })).toContainText(station.name);
  await expect(eventHeading).toBeInViewport();

  await page.goForward();
  await expect(page).toHaveURL(playersUrl);
  await expect(players).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(attendanceUrl);
  await expect(copy).toBeInViewport();
  expect(unexpected).toEqual([]);
});

test('activating a tab supersedes a smooth jump to an organiser control', async ({
  page,
}, testInfo) => {
  const { unexpected } = await mockEvent(page, { role: 'admin' });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(`/admin/event-operations?plan=${PLAN_ID}&view=run`);
  const tabs = page.getByRole('tablist', { name: 'Event workspace' });
  const settings = tabs.getByRole('tab', { name: 'Settings' });
  const heading = page
    .getByRole('tabpanel', { name: 'Settings' })
    .getByRole('heading', { name: 'Score approval' });
  await expect(page.getByRole('tabpanel', { name: 'Run matches' })).toBeVisible();
  await ready(page);

  // Activate Settings on the next frame after the real Stations jump starts.
  await settings.evaluate((tab) => {
    document.getElementById('station-controls')!.addEventListener(
      'focus',
      () => {
        requestAnimationFrame(() => {
          tab.focus({ preventScroll: true });
          tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        });
      },
      { once: true },
    );
  });
  await page.getByRole('button', { name: 'Stations', exact: true }).click();
  await expect(settings).toHaveAttribute('aria-selected', 'true');
  await expect(settings).toBeFocused();

  const lowestHeadingGap = await heading.evaluate(async (element) => {
    const strip = document.querySelector('[role="tablist"][aria-label="Event workspace"]')!;
    const start = performance.now();
    let lowestGap = Infinity;
    // The old smooth scroll can continue for several frames after Settings has focus.
    do {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const gap = element.getBoundingClientRect().top - strip.getBoundingClientRect().bottom;
      lowestGap = Math.min(lowestGap, gap);
    } while (performance.now() - start < 750);
    return Math.round(lowestGap);
  });
  expect(lowestHeadingGap).toBeGreaterThanOrEqual(0);
  await expectBelowTabs(heading, tabs);
  await expect(settings).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('settings-after-interrupted-jump.png') });
  expect(unexpected).toEqual([]);
});
