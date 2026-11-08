import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Locator } from '@playwright/test';
import { chooseOption } from '../test-support/controls';
import { mockEvent, PLAN_ID, ready } from './fixtures';

const first = 'Alex with a long doubles alias from Western Sydney';
const second = 'Jordan with the long tournament alias of the original teammate';
const replacement = 'Morgan with an equally long replacement player alias';
const reason = 'The original partner could not attend';

async function choose(control: Locator, value: string) {
  await control.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await chooseOption(control, value);
}

for (const theme of ['dark', 'light'] as const) {
  for (const width of [390, 1440]) {
    test(`doubles substitution reviews actual members at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const fixture = await mockEvent(page, { role: 'admin', idle: true });
      Object.assign(fixture.overview.plan, {
        name: 'Doubles substitute rehearsal',
        liveOwned: true,
        competitionFormat: 'doubles',
        structure: 'dual_division',
      });
      const pair = fixture.overview.entrants[0]!;
      pair.name = `${first} / ${second}`;
      const attendeeRoster = (teammate: { playerId: string; publicAlias: string }) => ({
        attendees: [{ playerId: 'staying', publicAlias: first }, teammate].map((player) => ({
          ...player,
          entryId: pair.id,
          canonicalName: player.publicAlias,
          displayName: null,
          rawInput: `${first} / ${second}`,
          cleanedName: `${first} / ${second}`,
          division: 'upper',
          companyCode: null,
          companyName: null,
        })),
        companies: [],
      });
      fixture.responses['eventOps.attendeeRoster'] = attendeeRoster({
        playerId: 'outgoing',
        publicAlias: second,
      });
      fixture.responses['public.searchPlayers'] = [
        { id: 'incoming', name: replacement, companyCode: null },
      ];
      fixture.responses['eventOps.delivery.status'] = { configured: false };
      fixture.responses['eventOps.previewDoublesSubstitution'] = {
        allowed: true,
        issues: [],
        returnCallMatchIds: [],
        revisionToken: 'preview-revision',
        oldMembers: [first, second],
        newMembers: [first, replacement],
        division: 'upper',
        poolIndex: 1,
        seed: 4,
        affectedMatchCount: 3,
      };
      fixture.responses['eventOps.applyDoublesSubstitution'] = { applied: true, sequence: 4 };

      await page.goto(`/operate/${PLAN_ID}?view=players`);
      const attendance = page.locator('section.card').filter({
        has: page.getByRole('heading', { name: 'Pair attendance', exact: true }),
      });
      await choose(attendance.getByRole('combobox', { name: 'Change', exact: true }), 'substitute');
      const pairControl = attendance.getByRole('combobox', { name: 'Pair', exact: true });
      await choose(pairControl, pair.id);
      await choose(attendance.getByRole('combobox', { name: 'Player to replace' }), 'outgoing');
      await attendance
        .getByRole('textbox', { name: 'Find a registered substitute by alias' })
        .fill('Morgan');
      await choose(
        attendance.getByRole('combobox', { name: 'Substitute', exact: true }),
        'incoming',
      );
      const previewButton = attendance.getByRole('button', { name: 'Preview substitution' });
      const confirm = attendance.getByRole('button', { name: 'Confirm substitute' });
      await expect(previewButton).toBeDisabled();
      await expect(confirm).toHaveCount(0);
      await attendance.getByRole('textbox', { name: 'Reason for substitution' }).fill(reason);
      await previewButton.press('Enter');

      const heading = attendance.getByRole('heading', { name: 'Substitution preview' });
      await expect(heading).toBeFocused();
      await expect(attendance.locator('dt')).toHaveText(['Current pair', 'Substitute pair']);
      await expect(attendance.locator('dd')).toHaveText([
        `${first} / ${second}`,
        `${first} / ${replacement}`,
      ]);
      await expect(attendance).toContainText('Upper · Pool B · Seed 4 · 3 affected matches');
      await expect(attendance).toContainText('The schedule and recorded results stay in place.');
      await ready(page);
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
      await page.evaluate(() => scrollTo(0, 0));
      await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
      await page.screenshot({
        path: testInfo.outputPath('players-substitution-preview.png'),
        fullPage: true,
      });
      await attendance.locator('.ops-attendance-preview').screenshot({
        path: testInfo.outputPath('substitution-preview-detail.png'),
      });
      await heading.focus();
      await page.keyboard.press('Tab');
      await expect(confirm).toBeFocused();
      await page.route(/\/api\/trpc\/.*eventOps\.applyDoublesSubstitution/, async (route) => {
        pair.name = `${first} / ${replacement}`;
        fixture.responses['eventOps.attendeeRoster'] = attendeeRoster({
          playerId: 'incoming',
          publicAlias: replacement,
        });
        await route.fallback();
      });
      const submitted = page.waitForRequest(
        (request) =>
          request.method() === 'POST' &&
          request.url().includes('eventOps.applyDoublesSubstitution'),
      );
      await confirm.press('Enter');
      const request = await submitted;
      const payload = request.postDataJSON();
      expect(payload[0] ?? payload).toMatchObject({
        planId: PLAN_ID,
        entrantId: pair.id,
        outgoingPlayerId: 'outgoing',
        incomingPlayerId: 'incoming',
        reason,
        revisionToken: 'preview-revision',
        requestId: expect.any(String),
      });
      await expect(attendance.getByRole('status')).toContainText('Substitute confirmed');
      await expect(pairControl).toBeFocused();
      const currentRoster = page.locator('#attendee-list');
      await expect(
        currentRoster.getByRole('cell', { name: replacement, exact: true }).first(),
      ).toBeVisible();
      await expect(currentRoster.getByRole('cell', { name: second, exact: true })).toHaveCount(0);
      await expect(
        currentRoster.getByRole('cell', { name: `${first} / ${second}`, exact: true }),
      ).toHaveCount(2);
      expect(fixture.unexpected).toEqual([]);
    });
  }
}
