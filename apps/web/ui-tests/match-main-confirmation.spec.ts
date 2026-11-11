import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mockEvent, PLAN_ID, PLAYER_NAME, ready } from './fixtures';

for (const width of [390, 1440]) {
  for (const colorScheme of ['dark', 'light'] as const) {
    test(`TO confirms a missing main at ${width}px in ${colorScheme}`, async ({
      page,
    }, testInfo) => {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      const fixture = await mockEvent(page, { role: 'admin' });
      const match = fixture.overview.matches.find((row) => row.status === 'playing')!;
      const player = { playerId: match.player1Id!, name: PLAYER_NAME };
      const candidates = [player];
      Object.assign(match, { player1Name: player.name });
      Object.assign(fixture.overview, { missingMains: { [match.id]: candidates } });
      const requests: unknown[] = [];
      await page.route('**/api/trpc/eventOps.live.confirmMatchMain*', async (route) => {
        const batch = new URL(route.request().url()).searchParams.has('batch');
        const body = route.request().postDataJSON();
        requests.push(batch ? body[0] : body);
        const response =
          requests.length === 1
            ? {
                error: {
                  message: 'Connection interrupted. Try again.',
                  code: -32603,
                  data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
                },
              }
            : { result: { data: { ok: true } } };
        if (requests.length > 1) candidates.pop();
        await route.fulfill({ json: batch ? [response] : response });
      });
      await page.goto(`/operate/${PLAN_ID}`);
      const card = page.locator('article.ops-match:visible').filter({ hasText: match.label });
      await card.getByRole('button', { name: 'Finish match', exact: true }).click();
      await card.getByRole('spinbutton').first().fill('2');
      const trigger = card.getByRole('button', { name: 'Confirm missing main' });
      await trigger.focus();
      await trigger.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Confirm a player’s main' });
      const playerSelect = dialog.getByRole('combobox', { name: 'Player', exact: true });
      await expect(playerSelect).toContainText(player.name);
      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();
      await expect(card.getByRole('spinbutton').first()).toHaveValue('2');
      expect(requests).toEqual([]);

      await trigger.press('Enter');
      const submit = dialog.getByRole('button', { name: 'Save confirmed main' });
      await expect(submit).toBeDisabled();
      const character = dialog.getByRole('combobox', { name: 'Main character' });
      await character.press('Enter');
      await expect(page.getByRole('option', { name: 'Choose a character' })).toBeFocused();
      await page.keyboard.press('End');
      await expect(page.getByRole('option', { name: 'Zero Suit Samus' })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(character).toHaveAttribute('data-value', 'zero-suit-samus');
      await ready(page);
      await expect(dialog).toBeInViewport();
      expect((await playerSelect.boundingBox())?.width).toBe(
        (await character.boundingBox())?.width,
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
          .violations,
      ).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath('confirm-missing-main.png') });

      await submit.click();
      await expect(dialog.getByRole('alert')).toContainText('Connection interrupted');
      await expect(character).toHaveAttribute('data-value', 'zero-suit-samus');
      await submit.click();
      await expect(dialog.getByRole('status')).toContainText(
        `Zero Suit Samus saved to ${player.name}’s profile.`,
      );
      await dialog.getByRole('button', { name: 'Done' }).click();
      await expect(trigger).toBeHidden();
      await expect(card.getByRole('spinbutton').first()).toHaveValue('2');
      expect(requests).toHaveLength(2);
      expect(requests[0]).toEqual({
        planId: PLAN_ID,
        matchId: match.id,
        playerId: player.playerId,
        character: 'zero-suit-samus',
      });
      expect(requests[1]).toEqual(requests[0]);
      expect(fixture.submissions).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
  }
}
