import { chooseOption, clearInput } from '../test-support/controls';
import { expect, test } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { mockEvent, PLAN_ID, PLAYER_NAME, ready } from './fixtures';

test('phone reporting preserves input, revision and pending feedback', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await mockEvent(page, { role: 'player' });
  await page.goto(`/play/${PLAN_ID}`);
  const card = page.locator('article.ops-match').filter({ hasText: PLAYER_NAME }).first();
  await expect(card).toBeVisible();
  const submit = card.getByRole('button', { name: /Submit score/ });
  const scores = card.getByRole('spinbutton');
  await expect(submit).toBeDisabled();
  await scores.nth(0).fill('2');
  await expect(submit).toBeEnabled();
  await ready(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page).toHaveScreenshot('player-report-phone.png');
  for (const replacement of ['0', '2']) {
    await clearInput(scores.nth(0));
    await expect(submit).toBeDisabled();
    await scores.nth(0).press(replacement);
    await expect(scores.nth(0)).toHaveValue(replacement);
  }
  await clearInput(scores.nth(1));
  await expect(submit).toBeDisabled();
  await scores.nth(1).press('Enter');
  expect(fixture.submissions).toHaveLength(0);
  await scores.nth(1).press('0');
  await expect(scores.nth(1)).toHaveValue('0');
  await expect(submit).toBeEnabled();
  await card.getByRole('button', { name: /Submit score/ }).click();
  await expect(card.getByRole('status')).toContainText('Score submitted for TO approval');
  expect(fixture.submissions).toHaveLength(1);
  const match = fixture.snapshot.matches.find(
    (item) => item.player1Name === PLAYER_NAME && item.status === 'playing',
  )!;
  expect(fixture.submissions[0]).toMatchObject({
    matchId: match.id,
    expectedRevision: match.revision,
    score1: 2,
    score2: 0,
    outcome: 'played',
  });
  expect(fixture.submissions[0]?.requestId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(fixture.unexpected).toEqual([]);
});

test('TO destinations retain edits and survive refresh; station opens shared score card', async ({
  page,
}) => {
  const fixture = await mockEvent(page, { role: 'admin' });
  await page.goto(`/operate/${PLAN_ID}`);
  await expect(page.getByRole('tab', { name: 'Run matches' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const run = page.getByRole('tabpanel', { name: 'Run matches' });
  await run.getByRole('button', { name: 'Finish match', exact: true }).first().click();
  await run.getByLabel(PLAYER_NAME, { exact: true }).fill('2');
  await page.getByRole('tab', { name: 'Players', exact: true }).click();
  await expect(run).toBeHidden();
  await expect(page).toHaveURL(/view=players/);
  await page.getByRole('tab', { name: 'Run matches' }).click();
  await expect(run.getByLabel(PLAYER_NAME, { exact: true })).toHaveValue('2');
  await page.getByRole('tab', { name: 'Broadcast' }).click();
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Broadcast' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(
    page
      .getByRole('tabpanel', { name: 'Broadcast' })
      .getByRole('button', { name: 'Update live score' }),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Run matches' }).click();
  await run.getByRole('button', { name: 'Score match' }).first().click();
  await expect(run.locator('#match-desk')).toBeFocused();
  await expect(run.locator('article.ops-match')).toHaveCount(1);
  await page.evaluate(() => scrollTo(0, 0));
  await ready(page);
  const result = await new AxeBuilder({ page })
    .include('.ops-page')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(result.violations).toEqual([]);
  await expect(page).toHaveScreenshot('to-desk-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page).toHaveScreenshot('to-desk-phone.png');
  expect(fixture.unexpected).toEqual([]);
});

for (const idle of [false, true]) {
  test(`OBS ${idle ? 'idle' : 'playing'} keeps the gameplay aperture clear and event identity readable`, async ({
    page,
  }) => {
    await mockEvent(page, { idle });
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(`/overlay/${PLAN_ID}`);
    await expect(page.locator('.broadcast-identity h1')).toHaveText('Tech In Place');
    await expect(page.locator('.app-nav')).toBeHidden();
    await expect(page.getByText('Find your rival.')).toHaveCount(0);
    const title = await page
      .locator('.broadcast-identity h1')
      .evaluate((element) => ({ width: element.clientWidth, scroll: element.scrollWidth }));
    expect(title.scroll).toBeLessThanOrEqual(title.width + 1);
    const opaque = await page.evaluate(() =>
      document
        .elementsFromPoint(1050, 400)
        .filter((element) => {
          const color = getComputedStyle(element).backgroundColor;
          return color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent';
        })
        .map((element) => element.className),
    );
    expect(opaque).toEqual([]);
    expect(await page.evaluate(() => getComputedStyle(document.body, '::before').display)).toBe(
      'none',
    );
    await ready(page);
    await expect(page).toHaveScreenshot(`overlay-${idle ? 'idle' : 'playing'}.png`, {
      omitBackground: true,
    });
  });
}

test('changing the broadcast station clears the previous match score draft', async ({ page }) => {
  const fixture = await mockEvent(page, { role: 'admin' });
  const alternate = fixture.snapshot.matches.find((match) => match.status === 'ready')!;
  const station = fixture.snapshot.stations[1]!;
  alternate.status = 'playing';
  alternate.stationId = station.id;
  station.currentMatchId = alternate.id;
  station.status = 'occupied';
  await page.goto(`/operate/${PLAN_ID}?view=broadcast`);
  const panel = page.getByRole('tabpanel', { name: 'Broadcast' });
  await panel.getByRole('button', { name: 'Update live score' }).click();
  await panel.getByLabel(PLAYER_NAME, { exact: true }).fill('3');
  await chooseOption(panel.getByRole('combobox', { name: 'Station', exact: true }), station.id);
  await expect(panel.getByRole('button', { name: 'Save live score' })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Update live score' }).click();
  await expect(panel.getByLabel(alternate.player1Name!, { exact: true })).toHaveValue('0');
  expect(fixture.unexpected).toEqual([]);
});

for (const role of [undefined, 'player'] as const) {
  test(`${role ?? 'guest'} can retry an event loading failure`, async ({ page }) => {
    const options = { role, failure: true };
    const fixture = await mockEvent(page, options);
    await page.goto(`/play/${PLAN_ID}`);
    await expect(page.getByRole('alert')).toContainText('Could not load');
    options.failure = false;
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page.locator('article.ops-match').first()).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(fixture.unexpected).toEqual([]);
  });
}

test('phone bracket preserves bye, unresolved pairing and long alias labels', async ({ page }) => {
  const fixture = await mockEvent(page, { bracket: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/live/${PLAN_ID}`);
  const brackets = page.locator('.event-brackets');
  await expect(brackets).toContainText('Semi-final A · Bye');
  await expect(brackets).toContainText('Winner of Semi-final B');
  await expect(brackets).toContainText(PLAYER_NAME);
  await expect(brackets.getByRole('heading', { name: 'Final', exact: true })).toBeVisible();
  await ready(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(brackets).toHaveScreenshot('bracket-phone.png');
  expect(fixture.unexpected).toEqual([]);
});
