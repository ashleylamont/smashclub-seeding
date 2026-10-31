import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { chooseOption, clearInput } from '../test-support/controls';
import { mockEvent, PLAN_ID, ready } from './fixtures';

async function openDesk(page: Page) {
  const fixture = await mockEvent(page, { role: 'admin' });
  const match = fixture.snapshot.matches.find((item) => item.status === 'playing')!;
  await page.goto(`/operate/${PLAN_ID}`);
  const card = page.locator('article.ops-match:visible').filter({ hasText: match.label });
  await expect(card).toBeVisible();
  return { fixture, match, card };
}

for (const width of [390, 1440]) {
  test(`${width}px TO records a reviewed forfeit with an explicit winner and no games`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const { fixture, match, card } = await openDesk(page);
    await card.getByRole('button', { name: 'Record forfeit', exact: true }).click();
    await expect(card.getByRole('spinbutton')).toHaveCount(0);
    const submit = card.getByRole('button', { name: 'Confirm forfeit', exact: true });
    await expect(submit).toBeDisabled();
    await chooseOption(
      card.getByRole('combobox', { name: 'Winner', exact: true }),
      match.player2Id!,
    );
    await expect(submit).toBeEnabled();
    await submit.click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText(match.player2Name!);
    await expect(dialog).toContainText('no played games or rating input');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(fixture.submissions).toHaveLength(0);
    await expect(card.getByRole('combobox', { name: 'Winner', exact: true })).toContainText(
      match.player2Name!,
    );
    await ready(page);
    expect(
      (
        await new AxeBuilder({ page })
          .include('.ops-page')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath(`forfeit-${width}.png`), fullPage: true });
    await submit.click();
    await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Forfeit recorded locally');
    expect(fixture.submissions).toHaveLength(1);
    expect(fixture.submissions[0]).toMatchObject({
      matchId: match.id,
      expectedRevision: match.revision,
      outcome: 'forfeit',
      winnerId: match.player2Id,
      score1: 0,
      score2: 0,
    });
    expect(fixture.submissions[0]!.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(fixture.unexpected).toEqual([]);
  });
}

test('switching a cleared played-score draft to forfeit removes numeric requirements and retains it when switching back', async ({
  page,
}) => {
  const { match, card } = await openDesk(page);
  await card.getByRole('button', { name: 'Finish match', exact: true }).click();
  await clearInput(card.getByRole('spinbutton').first());
  await expect(card.getByRole('button', { name: 'Confirm result', exact: true })).toBeDisabled();
  await chooseOption(card.getByRole('combobox', { name: 'Result type', exact: true }), 'forfeit');
  await expect(card.getByRole('spinbutton')).toHaveCount(0);
  await chooseOption(card.getByRole('combobox', { name: 'Winner', exact: true }), match.player1Id!);
  await expect(card.getByRole('button', { name: 'Confirm forfeit', exact: true })).toBeEnabled();
  await chooseOption(card.getByRole('combobox', { name: 'Result type', exact: true }), 'played');
  await expect(card.getByRole('spinbutton').first()).toHaveValue('');
  await expect(card.getByRole('button', { name: 'Confirm result', exact: true })).toBeDisabled();
});

test('a failed forfeit request keeps the selected winner and reuses its request ID on retry', async ({
  page,
}) => {
  const { match, card } = await openDesk(page);
  const requests: Record<string, unknown>[] = [];
  await page.route('**/api/trpc/eventOps.reportScore*', async (route) => {
    const url = new URL(route.request().url());
    const body = JSON.parse(route.request().postData() ?? '{}');
    requests.push(url.searchParams.get('batch') ? body[0] : body);
    const result =
      requests.length === 1
        ? {
            error: {
              message: 'Retry this result',
              code: -32603,
              data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
            },
          }
        : { result: { data: { status: 'approved' } } };
    await route.fulfill({ json: url.searchParams.get('batch') ? [result] : result });
  });
  await card.getByRole('button', { name: 'Record forfeit', exact: true }).click();
  await chooseOption(card.getByRole('combobox', { name: 'Winner', exact: true }), match.player1Id!);
  for (let attempt = 0; attempt < 2; attempt++) {
    await card.getByRole('button', { name: 'Confirm forfeit', exact: true }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Confirm', exact: true })
      .click();
    if (attempt === 0) await expect(page.getByRole('alert')).toContainText('Retry this result');
    else await expect(page.getByRole('status')).toContainText('Forfeit recorded locally');
  }
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
});

test('an updated match disables an old forfeit form without discarding its winner', async ({
  page,
}) => {
  const { fixture, match, card } = await openDesk(page);
  await card.getByRole('button', { name: 'Record forfeit', exact: true }).click();
  await chooseOption(card.getByRole('combobox', { name: 'Winner', exact: true }), match.player1Id!);
  match.revision++;
  await expect(card.getByRole('alert')).toContainText('Another TO updated this match', {
    timeout: 10000,
  });
  await expect(card.getByRole('button', { name: 'Confirm forfeit', exact: true })).toBeDisabled();
  await expect(card.getByRole('combobox', { name: 'Winner', exact: true })).toContainText(
    match.player1Name!,
  );
  expect(fixture.submissions).toHaveLength(0);
});

test('played-result and broadcast live-score drafts survive workspace navigation independently', async ({
  page,
}) => {
  const { card } = await openDesk(page);
  await card.getByRole('button', { name: 'Finish match', exact: true }).click();
  await card.getByRole('spinbutton').first().fill('2');
  await page.getByRole('tab', { name: 'Players', exact: true }).click();
  await page.getByRole('tab', { name: 'Run matches', exact: true }).click();
  await expect(card.getByRole('spinbutton').first()).toHaveValue('2');
  await page.getByRole('tab', { name: 'Broadcast', exact: true }).click();
  const broadcast = page.getByRole('tabpanel', { name: 'Broadcast', exact: true });
  await broadcast.getByRole('button', { name: 'Update live score', exact: true }).click();
  await broadcast.getByRole('spinbutton').first().fill('3');
  await page.getByRole('tab', { name: 'Run matches', exact: true }).click();
  await expect(card.getByRole('spinbutton').first()).toHaveValue('2');
  await page.getByRole('tab', { name: 'Broadcast', exact: true }).click();
  await expect(broadcast.getByRole('spinbutton').first()).toHaveValue('3');
});
