import { test, expect } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { mockEvent, PLAN_ID, PLAYER_NAME, ready, type FixtureOptions } from './fixtures';
import { chooseOption } from '../test-support/controls';

test('TO history supports paging, search, recorded details and opening a match on a phone', async ({
  page,
}) => {
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
  const fixture = await mockEvent(page, options);
  await page.goto(`/operate/${PLAN_ID}?view=history`);
  const history = page.getByRole('tabpanel', { name: 'History', exact: true });
  await expect(history.getByRole('heading', { name: 'Event history' })).toBeVisible();
  await expect(history.locator('.ops-history-entry')).toHaveCount(2);
  options.historyFailure = true;
  await history.getByRole('button', { name: 'Load older changes' }).click();
  await expect(history.getByRole('alert')).toContainText('History connection interrupted');
  await expect(history.locator('.ops-history-entry')).toHaveCount(2);
  options.historyFailure = false;
  await history.getByRole('button', { name: 'Retry history' }).click();
  await expect(history.locator('.ops-history-entry')).toHaveCount(3);
  await expect(history.getByRole('button', { name: 'Load older changes' })).toHaveCount(0);
  await history.getByLabel('Search loaded history').fill('Morgan');
  await expect(history.locator('.ops-history-entry')).toHaveCount(1);
  await history.getByLabel('Search loaded history').fill('');
  await chooseOption(history.getByRole('combobox', { name: 'Change type' }), 'results');
  await expect(history.getByRole('heading', { name: 'Results published' })).toBeVisible();
  await expect(history.locator('.ops-history-entry')).toHaveCount(1);
  await chooseOption(history.getByRole('combobox', { name: 'Change type' }), 'all');
  const correction = history.locator('.ops-history-entry').filter({ hasText: 'Result corrected' });
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
  await expect(page).toHaveScreenshot('event-history-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => scrollTo(0, 0));
  await expect(page.getByRole('tab', { name: 'History', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page).toHaveScreenshot('event-history-phone.png', { fullPage: true });
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
});

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
