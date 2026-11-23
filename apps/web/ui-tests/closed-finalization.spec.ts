import { readFile } from 'node:fs/promises';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { chooseOption } from '../test-support/controls';
import { bracketCaptureOptions, mockEvent, PLAN_ID, PLAYER_NAME, ready } from './fixtures';

const path = `/operate/${PLAN_ID}?view=draw`;
const resultId = '5a6b70c9-6709-4c3c-8660-696ed222f068';

for (const [width, theme] of [
  [390, 'dark'],
  [390, 'light'],
  [1440, 'dark'],
  [1440, 'light'],
] as const)
  test(`a finalized knockout keeps corrections and retires live actions at ${width}px in ${theme}`, async ({
    page,
  }, testInfo) => {
    const fixture = await mockEvent(page, { role: 'player', idle: true, bracket: true });
    const overview = fixture.overview;
    overview.matches = overview.matches.filter((match) => match.nativeBracketId);
    const opponentMatch = overview.matches.find(({ id }) => id === 'fixture-semi-b')!;
    Object.assign(opponentMatch, {
      status: 'complete',
      outcome: 'bye',
      winnerId: opponentMatch.player1Id,
    });
    const match = overview.matches.find(({ id }) => id === 'fixture-final')!;
    Object.assign(match, {
      status: 'complete',
      outcome: 'played',
      player1Name: PLAYER_NAME,
      player2Id: opponentMatch.player1Id,
      player2Name: opponentMatch.player1Name,
      score1: 2,
      score2: 0,
      winnerId: match.player1Id,
    });
    const winner = overview.entrants.find(({ id }) => id === match.player1Id)!;
    winner.name = PLAYER_NAME;
    Object.assign(overview.nativeBrackets[0]!, {
      complete: true,
      winnerId: match.player1Id,
      standings: [
        { playerId: match.player1Id, place: 1 },
        { playerId: match.player2Id, place: 2 },
      ],
    });
    Object.assign(fixture.overview.plan, { status: 'underway', structure: 'single_elimination' });
    Object.assign(fixture.overview, { finalization: { kind: 'ready' } });
    const finalizations: unknown[] = [];
    fixture.mutationResponses.set('eventOps.native.finalize', (input) => {
      finalizations.push(input);
      fixture.overview.plan.status = 'complete';
      Object.assign(fixture.overview, {
        finalization: null,
        publication: { resultId, revision: 1, status: 'published', tournamentIds: [] },
      });
      return { alreadyFinalized: false };
    });

    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
    await page.goto(path);
    const controls = page.locator('.native-finals-controls');
    const finalize = controls.getByRole('button', { name: 'Finalize native results' });
    await expect(finalize).toBeEnabled();
    await expect(finalize).toHaveAccessibleDescription(
      'Results are ready to publish. Finalizing ends live scoring.',
    );
    await expect(controls.getByText(/outstanding matches|reset final/i)).toHaveCount(0);
    await ready(page);
    await controls.screenshot({ path: testInfo.outputPath('ready-finalization.png') });

    await finalize.press('Enter');
    const dialog = page.getByRole('alertdialog');
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(finalize).toBeFocused();
    expect(finalizations).toEqual([]);

    await finalize.press('Enter');
    await dialog.getByRole('button', { name: 'Confirm', exact: true }).press('Enter');
    const feedback = controls.getByRole('group', { name: 'Finalization feedback' });
    await expect(feedback.getByRole('status')).toContainText('Event finalized');
    const corrections = page.locator('.native-result-correction');
    await expect(corrections).toContainText('Result revision 1 published.');
    await expect(finalize).toHaveCount(0);
    await expect(controls.getByText(/Results are ready to publish/)).toHaveCount(0);
    await expect(feedback).toBeFocused();
    expect(finalizations).toEqual([{ planId: PLAN_ID }]);
    await controls.screenshot({ path: testInfo.outputPath('finalization-feedback.png') });

    await page.reload();
    await expect(corrections).toContainText('Result revision 1 published.');
    await expect(controls).toHaveCount(0);
    const draw = page.getByRole('region', { name: 'Tournament draw' });
    await expect(draw).toContainText(`Winner · ${PLAYER_NAME}`);
    await chooseOption(corrections.getByRole('combobox', { name: 'Completed match' }), match.id);
    await corrections.getByRole('spinbutton', { name: match.player2Name! }).fill('1');
    await corrections
      .getByRole('textbox', { name: 'Ruling reason' })
      .fill('Reviewed the score sheet.');
    const publish = corrections.getByRole('button', { name: 'Publish reviewed correction' });
    await expect(publish).toBeEnabled();
    await publish.focus();
    await expect(publish).toBeFocused();
    await ready(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    expect(
      (
        await new AxeBuilder({ page })
          .include('.ops-page')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.screenshot({
      fullPage: true,
      style: await readFile(bracketCaptureOptions.stylePath, 'utf8'),
      path: testInfo.outputPath(`closed-knockout-${theme}-${width}.png`),
    });
    expect(fixture.unexpected).toEqual([]);
  });

for (const state of ['cancelled', 'blocked'] as const)
  test(`the closed ${state} knockout only shows applicable draw and publication actions`, async ({
    page,
  }) => {
    const fixture = await mockEvent(page, { role: 'player', idle: true });
    const publication = { resultId, revision: 1, status: 'blocked', tournamentIds: [] };
    Object.assign(fixture.overview.plan, {
      status: state === 'cancelled' ? 'cancelled' : 'complete',
      structure: 'double_elimination',
    });
    Object.assign(fixture.overview, {
      finalization: null,
      ...(state === 'blocked' && { publication }),
    });
    const recoveries: unknown[] = [];
    fixture.mutationResponses.set('eventOps.live.recover', (input) => {
      recoveries.push(input);
      publication.status = 'published';
      return { status: 'published' };
    });
    await page.goto(path);
    await expect(page.getByRole('heading', { name: fixture.overview.plan.name })).toBeVisible();
    await expect(page.locator('.native-finals-controls')).toHaveCount(0);
    await expect(
      page.getByText('No elimination bracket was generated for this event.'),
    ).toBeVisible();
    const correction = page.locator('.native-result-correction');
    if (state === 'cancelled') {
      await expect(correction).toHaveCount(0);
      expect(recoveries).toEqual([]);
    } else {
      await expect(correction).toContainText('Result publication needs recovery.');
      await correction.getByRole('button', { name: 'Retry result publication' }).press('Enter');
      await expect(correction).toContainText('Result revision 1 published.');
      expect(recoveries).toEqual([{ planId: PLAN_ID }]);
    }
    expect(fixture.unexpected).toEqual([]);
  });

for (const [width, theme] of [
  [390, 'light'],
  [1440, 'dark'],
] as const) {
  test(`withdraws print while a finalized correction is unpublished at ${width}px in ${theme}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
    const fixture = await mockEvent(page, { role: 'player', idle: true, bracket: true });
    const { overview } = fixture;
    Object.assign(overview.plan, { status: 'complete', structure: 'single_elimination' });
    const final = overview.matches.find((match) => match.id === 'fixture-final')!;
    const opponent = overview.matches.find((match) => match.id === 'fixture-semi-b')!;
    Object.assign(final, {
      status: 'complete',
      outcome: 'played',
      score1: 2,
      score2: 0,
      winnerId: final.player1Id,
      player2Id: opponent.player1Id,
      player2Name: opponent.player1Name,
    });
    const publication = { resultId, revision: 1, status: 'published', tournamentIds: [] };
    Object.assign(overview, { publication });
    fixture.mutationResponses.set('eventOps.live.recover', () => {
      publication.status = 'published';
      return { status: 'published' };
    });

    await page.goto(path);
    const draw = page.getByRole('region', { name: 'Tournament draw', exact: true });
    const print = draw.getByRole('button', { name: 'Print draw record', exact: true });
    const backup = draw.getByRole('button', { name: 'Print bracket backup sheets', exact: true });
    const dialog = page.getByRole('dialog', { name: 'Print draw record', exact: true });
    await expect(print).toBeVisible();
    await print.press('Enter');
    await expect(dialog).toContainText('Published draw record · Result revision 1');

    Object.assign(final, { score1: 0, score2: 2, winnerId: final.player2Id });
    Object.assign(publication, {
      resultId: 'e92a412f-b54d-4f2c-8dfc-07f9ccbbb3e1',
      revision: 2,
      status: 'pending',
    });
    const availability = draw.getByText(
      'Print the draw record after the current results are published.',
    );
    await expect(availability).toBeVisible({ timeout: 10_000 });
    await expect(dialog).toHaveCount(0);
    await expect(availability).toBeFocused();
    await expect(print).toHaveCount(0);
    await expect(backup).toHaveCount(0);
    await expect(page.locator('body')).not.toHaveClass(/printing-bracket-backups/);

    publication.status = 'blocked';
    await expect(page.getByText('Result publication needs recovery.')).toBeVisible({
      timeout: 10_000,
    });
    await expect(availability).toBeVisible();
    await expect(print).toHaveCount(0);
    await expect(backup).toHaveCount(0);
    await draw.screenshot({ path: testInfo.outputPath('blocked-draw-print.png') });

    await page.getByRole('button', { name: 'Retry result publication' }).press('Enter');
    await expect(print).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await print.press('Enter');
    await expect(dialog).toContainText('Published draw record · Result revision 2');
    const finalRow = dialog
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: /Championship final/ }) });
    await expect(finalRow).toContainText('0–2');
    await expect(finalRow).toContainText(`Winner: ${opponent.player1Name}`);
    await page.keyboard.press('Escape');
    await expect(print).toBeFocused();
    expect(fixture.unexpected).toEqual([]);
  });
}

test('remote cancellation clears a finals preview error without moving focus', async ({ page }) => {
  const fixture = await mockEvent(page, { role: 'player', idle: true });
  Object.assign(fixture.overview.plan, { status: 'underway', structure: 'dual_division' });
  const previewError = 'Could not load a finals preview.';
  fixture.queryFailures.set('eventOps.native.preview', previewError);

  await page.goto(path);
  const controls = page.locator('.native-finals-controls');
  await controls.getByRole('button', { name: 'Preview finals', exact: true }).press('Enter');
  await expect(controls.getByRole('alert')).toContainText(previewError);

  const publicBoard = page.getByRole('link', { name: /Public board/ });
  await publicBoard.focus();
  Object.assign(fixture.overview.plan, { status: 'cancelled' });
  Object.assign(fixture.overview, { finalization: null });
  await expect(
    page.getByText('No elimination bracket was generated for this event.'),
  ).toBeVisible();
  await expect(controls).toHaveCount(0);
  await expect(page.getByText(previewError, { exact: true })).toHaveCount(0);
  await expect(publicBoard).toBeFocused();

  await page.reload();
  await expect(
    page.getByText('No elimination bracket was generated for this event.'),
  ).toBeVisible();
  await expect(controls).toHaveCount(0);
  expect(fixture.unexpected).toEqual([]);
});

for (const failed of [false, true])
  test(`remote closure retains the finalization ${failed ? 'error' : 'receipt'} without moving focus`, async ({
    page,
  }) => {
    const fixture = await mockEvent(page, { role: 'player', idle: true, bracket: true });
    Object.assign(fixture.overview.plan, { status: 'underway', structure: 'single_elimination' });
    Object.assign(fixture.overview, { finalization: { kind: 'ready' } });
    let release!: () => void;
    const heldResponse = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finalizeRequest = /\/api\/trpc\/eventOps\.native\.finalize(?:\?|$)/;
    const finalizationError = 'The finalization response was interrupted.';
    await page.route(finalizeRequest, async (route) => {
      await heldResponse;
      const payload = failed
        ? {
            error: {
              message: finalizationError,
              code: -32603,
              data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
            },
          }
        : { result: { data: { alreadyFinalized: false } } };
      return route.fulfill({
        status: failed ? 500 : 200,
        json: new URL(route.request().url()).searchParams.has('batch') ? [payload] : payload,
      });
    });

    await page.goto(path);
    const controls = page.locator('.native-finals-controls');
    await controls.getByRole('button', { name: 'Finalize native results' }).press('Enter');
    const dialog = page.getByRole('alertdialog');
    const started = page.waitForRequest(finalizeRequest);
    const publicBoard = page.getByRole('link', { name: /Public board/ });
    try {
      await dialog.getByRole('button', { name: 'Confirm', exact: true }).press('Enter');
      await started;
      await expect(dialog).toHaveCount(0);
      await publicBoard.focus();
      Object.assign(fixture.overview.plan, { status: 'complete' });
      Object.assign(fixture.overview, {
        finalization: null,
        publication: { resultId, revision: 1, status: 'published', tournamentIds: [] },
      });
      await expect(page.getByText('Result revision 1 published.')).toBeVisible();
      await expect(controls).toHaveCount(0);
    } finally {
      release();
    }
    await expect(controls.getByRole(failed ? 'alert' : 'status')).toContainText(
      failed ? finalizationError : 'Event finalized.',
    );
    await expect(publicBoard).toBeFocused();
    await page.reload();
    await expect(page.getByText('Result revision 1 published.')).toBeVisible();
    await expect(controls).toHaveCount(0);
    expect(fixture.unexpected).toEqual([]);
  });
