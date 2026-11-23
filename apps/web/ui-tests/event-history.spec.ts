import { test, expect } from '@playwright/test';
import { darwinBaseline, darwinScreenshot } from './darwinScreenshot';
import { AxeBuilder } from '@axe-core/playwright';
import { mockEvent, PLAN_ID, PLAYER_NAME, ready, type FixtureOptions } from './fixtures';
import { chooseOption } from '../test-support/controls';

test(
  'TO history supports paging, search, recorded details and opening a match on a phone',
  darwinBaseline,
  async ({ page }) => {
    const options: FixtureOptions = {
      role: 'admin',
      history: [
        {
          entries: [
            {
              id: 'act:52',
              eventName: 'DecisionRecordedV1',
              version: 52,
              at: '2026-10-03T23:59:00.000Z',
              actor: 'Morgan the organiser',
              source: 'operator',
              category: 'scores',
              title: 'Result corrected',
              summary: `${PLAYER_NAME} vs Blair · 2–1 · played`,
              matchId: 'ff6d6dbb-7b65-46fa-b4d1-e8975a40f3a5',
              details: {
                commandId: 'recorded-correction',
                correctionOf: 'original-score',
                command: { kind: 'score', score1: 2, score2: 1 },
              },
            },
            {
              id: 'act:51',
              eventName: 'PublicationRecordedV1',
              version: 51,
              at: '2026-10-03T23:58:00.000Z',
              actor: 'Publication worker',
              source: 'system',
              category: 'results',
              title: 'Results published',
              summary: '4 result brackets published to club history.',
              matchId: null,
              details: { resultId: 'published-results' },
            },
          ],
          nextCursor: { source: 'act', before: 51 },
        },
        {
          entries: [
            {
              id: 'imported:original',
              eventName: 'record_score',
              version: null,
              at: '2026-10-03T20:00:00.000Z',
              actor: 'Original TO',
              source: 'imported',
              category: 'matches',
              title: 'record score',
              summary: 'Original audit record retained from before the live history started.',
              matchId: null,
              details: { before: { score1: null }, after: { score1: 2 } },
            },
          ],
          nextCursor: null,
        },
      ],
    };
    // Keep foreground polling from consuming the scripted failures for these manual controls.
    await page.addInitScript(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden' });
    });
    const fixture = await mockEvent(page, options);
    await page.goto(`/operate/${PLAN_ID}?view=history`);
    const history = page.getByRole('tabpanel', { name: 'History', exact: true });
    await expect(history.getByRole('heading', { name: 'Event history' })).toBeVisible();
    await expect(history.locator('.ops-history-entry')).toHaveCount(2);
    await expect(history.getByText('Load older changes to search further back.')).toBeVisible();
    options.historyFailure = true;
    await history.getByRole('button', { name: 'Load older changes' }).click();
    await expect(history.getByRole('alert')).toContainText('History connection interrupted');
    await expect(history.locator('.ops-history-entry')).toHaveCount(2);
    options.historyFailure = false;
    await history.getByRole('button', { name: 'Retry history' }).click();
    await expect(history.locator('.ops-history-entry')).toHaveCount(3);
    await expect(history.getByRole('button', { name: 'Load older changes' })).toHaveCount(0);
    await expect(history.getByText('Load older changes to search further back.')).toHaveCount(0);
    await history.getByLabel('Search loaded history').fill('Morgan');
    await expect(history.getByText(/1 of 3 recorded changes/)).toBeVisible();
    await expect(history.locator('.ops-history-entry')).toHaveCount(1);
    await history.getByLabel('Search loaded history').fill('');
    await chooseOption(history.getByRole('combobox', { name: 'Change type' }), 'results');
    await expect(history.getByRole('heading', { name: 'Results published' })).toBeVisible();
    await expect(history.locator('.ops-history-entry')).toHaveCount(1);
    await chooseOption(history.getByRole('combobox', { name: 'Change type' }), 'all');
    const correction = history
      .locator('.ops-history-entry')
      .filter({ hasText: 'Result corrected' });
    await correction.getByRole('button', { name: 'View recorded details' }).click();
    await expect(correction.getByText('original-score', { exact: false })).toBeVisible();
    const imported = history.locator('.ops-history-entry').filter({ hasText: 'Imported audit' });
    await imported.getByRole('button', { name: 'View recorded details' }).click();
    await expect(imported).toContainText('predates the live event stream');
    await page.evaluate(() => scrollTo(0, 0));
    await ready(page);
    expect(
      (
        await new AxeBuilder({ page })
          .include('.ops-page')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    // Report both viewport differences in the same run.
    await expect(history.getByRole('button', { name: 'Refresh history' })).toBeEnabled();
    await darwinScreenshot(page, 'event-history-desktop.png', { soft: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => scrollTo(0, 0));
    await expect(page.getByRole('tab', { name: 'History', exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await expect(history.getByRole('button', { name: 'Refresh history' })).toBeEnabled();
    await darwinScreenshot(page, 'event-history-phone.png', { fullPage: true });
    options.historyFailure = true;
    await history.getByRole('button', { name: 'Refresh history' }).click();
    await expect(history.getByRole('alert')).toContainText('History connection interrupted');
    await expect(history.locator('.ops-history-entry')).toHaveCount(3);
    options.historyFailure = false;
    await history.getByRole('button', { name: 'Retry history' }).click();
    await expect(history.getByRole('alert')).toHaveCount(0);
    await correction.getByRole('button', { name: 'Open match' }).click();
    await expect(page).toHaveURL(/view=run/);
    await expect(page.locator('#match-desk')).toBeFocused();
    await expect(page.locator('article.ops-match:visible')).toHaveCount(1);
    expect(fixture.unexpected).toEqual([]);
  },
);

test('native drafts explain when recording starts without issuing a history request', async ({
  page,
}) => {
  const fixture = await mockEvent(page, { role: 'admin' });
  fixture.overview.plan.liveOwned = false;
  await page.goto(`/operate/${PLAN_ID}?view=history`);
  await expect(page.getByRole('heading', { name: 'Live history has not started' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh history' })).toHaveCount(0);
  expect(fixture.unexpected).toEqual([]);
});

test('initial history loading and failure stay distinct from a confirmed empty history', async ({
  page,
}, testInfo) => {
  const options: FixtureOptions = { role: 'admin', historyFailure: true };
  const fixture = await mockEvent(page, options);
  let releaseHistory!: () => void;
  const response = new Promise<void>((resolve) => {
    releaseHistory = resolve;
  });
  await page.route(/\/api\/trpc\/.*eventOps\.live\.history/, async (route) => {
    await response;
    await route.fallback();
  });
  await page.goto(`/operate/${PLAN_ID}?view=history`);
  const history = page.getByRole('region', { name: 'Event history', exact: true });
  await expect(history.getByRole('status')).toContainText('Loading event history');
  await expect(history.getByText(/0 of 0/)).toHaveCount(0);
  releaseHistory();
  await expect(history.getByRole('alert')).toContainText('History connection interrupted');
  await expect(history.getByText(/0 of 0/)).toHaveCount(0);
  await expect(history.getByText(/No event changes/)).toHaveCount(0);
  await ready(page);
  await testInfo.attach('initial-history-failure', {
    body: await page.screenshot({ animations: 'disabled' }),
    contentType: 'image/png',
  });
  options.historyFailure = false;
  await history.getByRole('button', { name: 'Retry history' }).focus();
  await page.keyboard.press('Enter');
  await expect(history.getByText('No event changes have been recorded.')).toBeVisible();
  await expect(history.getByRole('alert')).toHaveCount(0);
  expect(fixture.unexpected).toEqual([]);
});

test('opening history offline waits for a connection before stating a record count', async ({
  page,
  context,
}) => {
  const fixture = await mockEvent(page, { role: 'admin' });
  await page.goto(`/operate/${PLAN_ID}?view=run`);
  const historyTab = page.getByRole('tab', { name: 'History', exact: true });
  await expect(historyTab).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByText(/Live updates interrupted/)).toBeVisible();
  await historyTab.focus();
  await page.keyboard.press('Enter');
  const history = page.getByRole('region', { name: 'Event history', exact: true });
  await expect(history.getByRole('status')).toContainText('Waiting for a connection');
  await expect(history.getByText(/0 of 0/)).toHaveCount(0);
  await context.setOffline(false);
  await expect(history.getByText('No event changes have been recorded.')).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
});

test('closed native events without live history do not invite organisers to start play', async ({
  page,
}) => {
  const fixture = await mockEvent(page, { role: 'admin' });
  fixture.overview.plan.liveOwned = false;
  fixture.overview.plan.status = 'cancelled';
  await page.goto(`/operate/${PLAN_ID}?view=history`);
  await expect(page.getByText('Event cancelled.', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No live history was recorded' })).toBeVisible();
  await expect(page.getByText(/Native events begin recording/)).toHaveCount(0);
  expect(fixture.unexpected).toEqual([]);
});

for (const theme of ['dark', 'light'] as const) {
  for (const width of [390, 1440] as const) {
    test(`history and attendance scope in ${theme} at ${width}px`, async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      const earlier = {
        id: 'act:19',
        eventName: 'AttendanceChangedV1',
        version: 19,
        at: '2026-10-03T23:49:00.000Z',
        actor: 'Morgan the organiser',
        source: 'operator',
        category: 'players',
        title: 'Entrant withdrawn',
        summary: `${PLAYER_NAME} was withdrawn.`,
        matchId: null,
        details: { player: PLAYER_NAME, reason: 'Left before play' },
      } as const;
      const fixture = await mockEvent(page, {
        role: 'admin',
        history: [
          {
            entries: [
              {
                ...earlier,
                id: 'act:21',
                version: 21,
                at: '2026-10-03T23:58:00.000Z',
                title: 'Entrant restored',
                summary: `${PLAYER_NAME} returned to the event.`,
                details: { player: PLAYER_NAME, reason: 'Returned before the next match' },
              },
              {
                ...earlier,
                id: 'act:20',
                version: 20,
                at: '2026-10-03T23:50:00.000Z',
                category: 'results',
                title: 'Results published',
                summary: 'Results published to club history.',
                details: { resultId: 'published-results' },
              },
              earlier,
            ],
            nextCursor: null,
          },
        ],
      });
      fixture.overview.plan.status = 'complete';
      await page.goto(`/operate/${PLAN_ID}?view=history`);
      await expect(page.getByText('Live play ended.', { exact: true })).toBeVisible();
      const history = page.getByRole('region', { name: 'Event history', exact: true });
      await expect(history.getByText(/3 of 3 recorded changes.*Newest first/)).toBeVisible();
      await expect(history.getByRole('listitem').getByRole('heading')).toHaveText([
        'Entrant restored',
        'Results published',
        'Entrant withdrawn',
      ]);
      const restored = history.getByRole('listitem').filter({
        has: page.getByRole('heading', { name: 'Entrant restored' }),
      });
      const disclosure = restored.getByRole('button', { name: 'View recorded details' });
      await expect(disclosure).toBeVisible();
      await disclosure.focus();
      await page.keyboard.press('Enter');
      await expect(
        restored.getByText('Returned before the next match', { exact: false }),
      ).toBeVisible();
      await ready(page);
      await page.evaluate(() => scrollTo(0, 0));
      await testInfo.attach('event-history', {
        body: await page.screenshot({ animations: 'disabled', fullPage: true }),
        contentType: 'image/png',
      });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(
        (
          await new AxeBuilder({ page })
            .include('.ops-page')
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);

      await page.getByRole('tab', { name: 'Players', exact: true }).focus();
      await page.keyboard.press('Enter');
      const attendance = page.getByRole('region', { name: 'Attendance history', exact: true });
      await expect(
        attendance.getByText(/2 of 2 recorded attendance changes.*Earliest first/),
      ).toBeVisible();
      await expect(attendance.getByRole('listitem').getByRole('heading')).toHaveText([
        'Entrant withdrawn',
        'Entrant restored',
      ]);
      const search = attendance.getByRole('searchbox', { name: 'Search loaded history' });
      await search.focus();
      await page.keyboard.insertText('returned');
      await expect(attendance.getByText(/1 of 2 recorded attendance changes/)).toBeVisible();
      await expect(attendance.getByRole('heading', { name: 'Entrant restored' })).toBeVisible();
      await expect(attendance.getByRole('heading', { name: 'Entrant withdrawn' })).toHaveCount(0);
      await search.fill('nobody');
      await expect(attendance.getByText('No changes match this view.')).toBeVisible();
      await search.fill('');
      await expect(attendance.getByRole('listitem')).toHaveCount(2);
      await ready(page);
      await page.evaluate(() => scrollTo(0, 0));
      await testInfo.attach('attendance-history', {
        body: await page.screenshot({ animations: 'disabled', fullPage: true }),
        contentType: 'image/png',
      });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(
        (
          await new AxeBuilder({ page })
            .include('.ops-page')
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
  }
}
