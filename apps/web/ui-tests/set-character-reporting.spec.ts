import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { chooseOption } from '../test-support/controls';
import { mockEvent, PLAN_ID, PLAYER_NAME, ready } from './fixtures';

for (const width of [390, 1440]) {
  for (const colorScheme of ['dark', 'light'] as const) {
    test(`optional set picks at ${width}px in ${colorScheme}`, async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      const fixture = await mockEvent(page, { role: 'player' });
      const match = fixture.snapshot.matches.find((row) => row.status === 'playing')!;
      const guest = colorScheme === 'light';
      const doubles = (width === 1440) !== guest;
      const playerId = doubles ? '00000000-0000-4000-8000-000000000051' : match.player1Id!;
      if (doubles) {
        const partnerId = '00000000-0000-4000-8000-000000000052';
        const opponentId = '00000000-0000-4000-8000-000000000053';
        const opponentPartnerId = '00000000-0000-4000-8000-000000000054';
        Object.assign(match, {
          player1Name: `${PLAYER_NAME} / Billie`,
          player1MemberIds: [playerId, partnerId],
          player2Name: 'Chrom / Jordan',
          player2MemberIds: [opponentId, opponentPartnerId],
        });
        Object.assign(fixture.snapshot, {
          memberNames: {
            [playerId]: PLAYER_NAME,
            [partnerId]: 'Billie',
            [opponentId]: 'Chrom',
            [opponentPartnerId]: 'Jordan',
          },
        });
      }
      const sessionToken = 'set-character-fixture-token'.repeat(2);
      const guestView = { ...fixture.snapshot, reports: [] as unknown[] };
      if (guest) {
        fixture.snapshot.settings.playerReports = false;
        fixture.responses['eventOps.guests.redeem'] = { sessionToken, expiresAt: null };
        fixture.responses['eventOps.guests.matches'] = guestView;
      }
      const requests: Record<string, unknown>[] = [];
      const procedure = guest ? 'eventOps.guests.submit' : 'eventOps.reportScore';
      await page.route(`**/api/trpc/${procedure}*`, async (route) => {
        const batch = new URL(route.request().url()).searchParams.has('batch');
        const body = route.request().postDataJSON();
        const payload = batch ? body[0] : body;
        requests.push(payload);
        const retry = requests.length === 1;
        const response = retry
          ? {
              error: {
                message: 'Reporting connection interrupted.',
                code: -32603,
                data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
              },
            }
          : { result: { data: { status: 'pending', isDispute: false } } };
        if (!retry) {
          const reports = [
            {
              id: 'report',
              matchId: match.id,
              status: 'pending',
              score1: 2,
              score2: 0,
              isDispute: false,
              characterPicks: payload.characterPicks,
            },
          ];
          if (guest) guestView.reports = reports;
          else fixture.responses['eventOps.myReports'] = reports;
        }
        await route.fulfill({ json: batch ? [response] : response });
      });
      await page.goto(`/play/${PLAN_ID}${guest ? '#token=venue-invitation' : ''}`);
      const card = page.locator('article.ops-match').filter({ hasText: match.label });
      const submit = card.getByRole('button', { name: /Submit score/ });
      await card.getByRole('spinbutton').first().fill('2');
      await expect(submit).toBeEnabled();
      const opener = card.getByRole('button', { name: 'Add characters (optional)' });
      await opener.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Characters played' });
      const fighter = dialog.getByRole('combobox', { name: `Add fighter for ${PLAYER_NAME}` });
      await fighter.press('Enter');
      await expect(page.getByRole('option', { name: 'Add fighter', exact: true })).toBeFocused();
      await page.keyboard.press('End');
      await expect(page.getByRole('option', { name: 'Zero Suit Samus' })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(dialog.getByRole('button', { name: /^Remove Zero Suit Samus/ })).toBeVisible();
      await chooseOption(fighter, 'fox');
      await chooseOption(fighter, 'falco');
      await dialog.getByRole('button', { name: /^Remove Zero Suit Samus/ }).click();
      await ready(page);
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
          .violations,
      ).toEqual([]);
      await expect(dialog).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: testInfo.outputPath('set-characters.png') });
      await page.keyboard.press('Escape');
      const edit = card.getByRole('button', { name: 'Edit characters (2)' });
      await expect(edit).toBeFocused();
      await expect(card.getByRole('spinbutton').first()).toHaveValue('2');
      expect(requests).toEqual([]);

      await submit.click();
      await expect(card.getByRole('alert')).toContainText('Reporting connection interrupted');
      await expect(edit).toBeVisible();
      await submit.click();
      await expect(card.getByRole('list', { name: 'Reported characters' })).toContainText(
        `${PLAYER_NAME} · Fox, Falco`,
      );
      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({
        matchId: match.id,
        expectedRevision: match.revision,
        score1: 2,
        score2: 0,
        characterPicks: [{ playerId, characters: ['fox', 'falco'] }],
      });
      expect(requests[1]).toEqual(requests[0]);
      expect(fixture.unexpected).toEqual([]);
    });
  }
}

test('organisers see the submitted characters before and after score approval', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await mockEvent(page, { role: 'admin' });
  const report = fixture.overview.reports[0]!;
  const match = fixture.overview.matches.find(({ id }) => id === report.matchId)!;
  Object.assign(report, {
    status: 'pending',
    characterPicks: [{ playerId: match.player1Id!, characters: ['pikachu'] }],
  });
  await page.goto(`/operate/${PLAN_ID}`);
  const submissions = page.getByRole('region', { name: 'Score submissions' });
  await expect(submissions.getByRole('list', { name: 'Reported characters' })).toContainText(
    'Pikachu',
  );
  report.status = 'approved';
  const approved = submissions.getByRole('button', {
    name: 'Reported characters from approved scores',
  });
  await expect(approved).toBeVisible();
  await expect(submissions.getByRole('list', { name: 'Reported characters' })).toBeHidden();
  await approved.press('Enter');
  await expect(submissions.getByRole('list', { name: 'Reported characters' })).toContainText(
    'Pikachu',
  );
  await ready(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await submissions.screenshot({ path: testInfo.outputPath('approved-character-report.png') });
  expect(fixture.unexpected).toEqual([]);
});
