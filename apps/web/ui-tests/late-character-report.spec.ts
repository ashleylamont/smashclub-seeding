import { expect, test } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { mockEvent, PLAN_ID, PLAYER_NAME, ready } from './fixtures';
import { chooseOption } from '../test-support/controls';

for (const [width, colorScheme] of [
  [390, 'dark'],
  [390, 'light'],
  [1440, 'dark'],
  [1440, 'light'],
] as const) {
  test(`a claimed player adds characters to a completed set at ${width}px in ${colorScheme}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme });
    const fixture = await mockEvent(page, { role: 'player' });
    const match = fixture.snapshot.matches.find(
      (row) => row.outcome === 'played' && row.status === 'complete',
    )!;
    const claim = { status: 'approved', playerId: match.player1Id!, playerName: PLAYER_NAME };
    fixture.responses['me.claims'] = [claim];
    fixture.snapshot.plan.status = 'complete';
    Object.assign(match, { player1Name: PLAYER_NAME });
    const picks = [{ playerId: claim.playerId, characters: ['fox', 'falco'] }];
    const requests: unknown[] = [];
    await page.route('**/api/trpc/me.reportPlayedCharacters*', async (route) => {
      const batch = new URL(route.request().url()).searchParams.has('batch');
      const body = route.request().postDataJSON();
      requests.push(batch ? body[0] : body);
      const response =
        requests.length === 1
          ? {
              error: {
                code: -32603,
                message: 'Connection interrupted.',
                data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
              },
            }
          : { result: { data: { ok: true } } };
      if (requests.length > 1)
        Object.assign(fixture.snapshot, { charactersPlayed: { [match.id]: picks } });
      await route.fulfill({ json: batch ? [response] : response });
    });
    await page.goto(`/play/${PLAN_ID}?player=${claim.playerId}`);
    await page.getByRole('button', { name: /Match filters/ }).click();
    await chooseOption(page.getByRole('combobox', { name: 'Match view' }), 'results');
    const card = page.locator('article.ops-match').filter({ hasText: match.label });
    const opener = card.getByRole('button', { name: 'Report characters played' });
    await opener.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Characters played' });
    const picker = dialog.getByRole('combobox', { name: `Add fighter for ${PLAYER_NAME}` });
    const save = dialog.getByRole('button', { name: 'Save character report' });
    await expect(save).toBeDisabled();
    await chooseOption(picker, 'fox');
    await chooseOption(picker, 'falco');
    await ready(page);
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations,
    ).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath('late-report.png') });
    await save.click();
    await expect(dialog.getByRole('alert')).toContainText('Connection interrupted');
    await expect(
      dialog.getByRole('button', { name: `Remove Fox for ${PLAYER_NAME}` }),
    ).toBeVisible();
    await save.click();
    await expect(dialog.getByRole('status')).toContainText('Character report saved');
    await page.keyboard.press('Escape');
    await expect(opener).toBeFocused();
    await expect(card.getByRole('list', { name: 'Reported characters' })).toContainText(
      'Fox, Falco',
    );
    expect(requests).toEqual(
      [0, 1].map(() => ({
        target: { kind: 'native', planId: PLAN_ID, matchId: match.id },
        picks,
      })),
    );
    expect(fixture.submissions).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
}
