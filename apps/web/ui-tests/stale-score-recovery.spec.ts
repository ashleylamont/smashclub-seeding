import { expect, test } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { chooseOption } from '../test-support/controls';
import { mockEvent, PLAN_ID, PLAYER_NAME, ready } from './fixtures';

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test(`${theme} ${width}px stale score recovery keeps scores and characters for review`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const fixture = await mockEvent(page, { role: 'player' });
      const match = fixture.snapshot.matches.find((item) => item.status === 'playing')!;
      await page.goto(`/play/${PLAN_ID}#my-matches`);
      const card = page.locator(`[data-player-match-id="${match.id}"]`);
      const first = card.getByRole('spinbutton', { name: PLAYER_NAME });
      const second = card.getByRole('spinbutton', { name: match.player2Name! });
      await first.fill('2');
      await second.fill('1');
      await card.getByRole('button', { name: 'Add characters (optional)' }).click();
      const characters = page.getByRole('dialog');
      await chooseOption(characters.getByRole('combobox').first(), 'fox');
      await characters.getByRole('button', { name: 'Done', exact: true }).click();

      match.revision++;
      const reload = card.getByRole('button', { name: 'Reload match' });
      const submit = card.getByRole('button', { name: /Submit score/ });
      await expect(reload).toBeEnabled();
      await expect(first).toHaveValue('2');
      await expect(second).toHaveValue('1');
      await expect(submit).toBeDisabled();
      const filters = page.getByRole('button', { name: /Match filters/ });
      await expect(filters).toHaveAttribute('aria-expanded', 'true');
      await ready(page);
      await card.scrollIntoViewIfNeeded();
      await reload.focus();
      await page.screenshot({ path: testInfo.outputPath('stale-score.png') });
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
          .violations,
      ).toEqual([]);

      await page.keyboard.press('Enter');
      await expect(reload).toHaveCount(0);
      await expect(card).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(first).toBeFocused();
      await expect(first).toHaveValue('2');
      await expect(second).toHaveValue('1');
      await expect(card.getByRole('button', { name: 'Edit characters (1)' })).toBeEnabled();
      await expect(submit).toBeEnabled();
      expect(fixture.submissions).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: testInfo.outputPath('reviewed-score.png') });
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
          .violations,
      ).toEqual([]);

      await submit.focus();
      await page.keyboard.press('Enter');
      await expect(card).toContainText('Score submitted for TO approval');
      expect(fixture.submissions).toMatchObject([
        {
          matchId: match.id,
          expectedRevision: match.revision,
          score1: 2,
          score2: 1,
          characterPicks: [{ playerId: match.player1Id, characters: ['fox'] }],
        },
      ]);
      expect(fixture.unexpected).toEqual([]);
    });

test('stale recovery waits for a pending submission and gives its new revision a fresh request ID', async ({
  page,
}) => {
  const fixture = await mockEvent(page, { role: 'player' });
  const match = fixture.snapshot.matches.find((item) => item.status === 'playing')!;
  const requests: Record<string, unknown>[] = [];
  let finishFirst!: () => void;
  const firstPending = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  await page.route('**/api/trpc/eventOps.reportScore*', async (route) => {
    const batch = new URL(route.request().url()).searchParams.has('batch');
    const body = JSON.parse(route.request().postData()!);
    requests.push(batch ? body[0] : body);
    if (requests.length !== 1) return route.fallback();
    await firstPending;
    const error = {
      error: {
        message: 'The first report failed. Try again.',
        code: -32603,
        data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
      },
    };
    await route.fulfill({ status: 500, json: batch ? [error] : error });
  });
  await page.goto(`/play/${PLAN_ID}`);
  const card = page.locator(`[data-player-match-id="${match.id}"]`);
  const scores = card.getByRole('spinbutton');
  const submit = card.getByRole('button', { name: /Submit score/ });
  const reload = card.getByRole('button', { name: 'Reload match' });
  await scores.nth(0).fill('2');
  await scores.nth(1).fill('1');
  await submit.click();
  try {
    await expect.poll(() => requests).toHaveLength(1);
    match.revision++;
    await expect(reload).toBeVisible();
    await expect(reload).toBeDisabled();
    await expect(submit).toBeDisabled();
  } finally {
    finishFirst();
  }

  await expect(card.getByText('The first report failed. Try again.')).toBeVisible();
  await expect(reload).toBeEnabled();
  await reload.click();
  await expect(card.getByText('The first report failed. Try again.')).toHaveCount(0);
  await expect(scores.nth(0)).toHaveValue('2');
  await expect(scores.nth(1)).toHaveValue('1');
  expect(requests).toHaveLength(1);
  await submit.click();
  await expect(card).toContainText('Score submitted for TO approval');
  expect(requests).toHaveLength(2);
  expect(requests[0]).toMatchObject({
    matchId: match.id,
    expectedRevision: match.revision - 1,
    requestId: expect.any(String),
    score1: 2,
    score2: 1,
  });
  expect(requests[1]).toEqual({
    ...requests[0],
    expectedRevision: match.revision,
    requestId: expect.any(String),
  });
  expect(requests[1]?.requestId).not.toBe(requests[0]?.requestId);
  expect(fixture.unexpected).toEqual([]);
});

test('blocked matches and swapped sides discard drafts from the previous reportable pairing', async ({
  page,
}) => {
  const fixture = await mockEvent(page, { role: 'player' });
  const match = fixture.snapshot.matches.find((item) => item.status === 'playing')!;
  await page.goto(`/play/${PLAN_ID}?match=${match.id}`);
  const card = page.locator(`[data-player-match-id="${match.id}"]`);
  const scores = card.getByRole('spinbutton');
  await scores.nth(0).fill('2');
  await scores.nth(1).fill('1');
  Object.assign(match, { status: 'blocked', revision: match.revision + 1 });
  await expect(card).toContainText('Waiting for earlier matches');
  await expect(scores).toHaveCount(0);

  Object.assign(match, { status: 'ready', revision: match.revision + 1 });
  await expect(scores.nth(0)).toHaveValue('0');
  await expect(scores.nth(1)).toHaveValue('0');
  await scores.nth(0).fill('3');
  Object.assign(match, {
    player1Id: match.player2Id,
    player1Name: match.player2Name,
    player2Id: match.player1Id,
    player2Name: match.player1Name,
    revision: match.revision + 1,
  });
  await expect(scores.nth(1)).toHaveAccessibleName(PLAYER_NAME);
  await expect(scores.nth(0)).toHaveValue('0');
  await expect(scores.nth(1)).toHaveValue('0');
  await expect(card.getByRole('button', { name: /Submit score/ })).toBeDisabled();
  expect(fixture.submissions).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test('a revision change with the same official result keeps an in-progress dispute', async ({
  page,
}) => {
  const fixture = await mockEvent(page, { role: 'player' });
  fixture.snapshot.settings.scoreReportingMode = 'approve_unless_disputed';
  const match = fixture.snapshot.matches.find((item) => item.status === 'playing')!;
  Object.assign(match, {
    status: 'complete',
    outcome: 'played',
    winnerId: match.player2Id,
    score1: 1,
    score2: 3,
  });
  fixture.mutationResponses.set('eventOps.reportScore', (input) => {
    fixture.submissions.push(input as Record<string, unknown>);
    return { id: 'stale-score-dispute', status: 'pending', isDispute: true };
  });
  await page.goto(`/play/${PLAN_ID}?match=${match.id}`);
  const card = page.locator(`[data-player-match-id="${match.id}"]`);
  await card.getByRole('button', { name: 'Report a different score' }).click();
  const scores = card.getByRole('spinbutton');
  await scores.nth(0).fill('2');
  await scores.nth(1).fill('1');
  match.revision++;
  const reload = card.getByRole('button', { name: 'Reload match' });
  const confirm = card.getByRole('button', { name: 'Confirm recorded score' });
  const dispute = card.getByRole('button', { name: 'Send different score to TOs' });
  await expect(reload).toBeVisible();
  await expect(confirm).toBeDisabled();
  await expect(dispute).toBeDisabled();
  await reload.click();
  await expect(card).toContainText('Confirmed result: 1 – 3');
  await expect(scores.nth(0)).toHaveValue('2');
  await expect(scores.nth(1)).toHaveValue('1');
  expect(fixture.submissions).toEqual([]);
  await dispute.click();
  await expect
    .poll(() => fixture.submissions)
    .toMatchObject([{ matchId: match.id, expectedRevision: match.revision, score1: 2, score2: 1 }]);
  expect(fixture.unexpected).toEqual([]);
});
