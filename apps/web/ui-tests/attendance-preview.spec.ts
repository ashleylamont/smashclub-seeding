import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Locator } from '@playwright/test';
import { chooseOption } from '../test-support/controls';
import { mockEvent, PLAN_ID, ready } from './fixtures';

async function chooseAttendanceOption(control: Locator, value: string) {
  await control.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await chooseOption(control, value);
}

for (const theme of ['dark', 'light'] as const) {
  for (const width of [390, 1440]) {
    for (const linked of [false, true]) {
      test(`${theme} ${width}px ${linked ? 'linked' : 'native'} attendance preview shows only required acknowledgements`, async ({
        page,
      }, testInfo) => {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
        const fixture = await mockEvent(page, { role: 'admin' });
        Object.assign(fixture.overview.plan, {
          bracketMode: linked ? 'challonge' : 'native',
          liveOwned: !linked,
        });
        const entrant = fixture.overview.entrants[0]!;
        entrant.name = 'Alex with a long tournament alias and an attendance update';
        const revisionToken = 'attendance-preview-revision';
        fixture.responses['eventOps.previewAttendance'] = {
          allowed: true,
          issues: [],
          warnings: linked
            ? [
                'This event has a linked Challonge bracket. Update its roster or withdrawal there manually and sync it.',
              ]
            : [
                'Completed matches stay recorded. Outstanding matches need an explicit forfeit decision.',
              ],
          requiresExternalAcknowledgement: linked,
          requiresRedistributionApproval: false,
          relocations: [],
          affectedMatches: [
            { id: 'affected-match', label: 'Upper · Pool A · Round 1', status: 'ready' },
          ],
          addedMatches: 0,
          revisionToken,
        };
        fixture.responses['eventOps.applyAttendance'] = { ok: true };
        fixture.responses['eventOps.delivery.status'] = { configured: false };

        await page.goto(`/operate/${PLAN_ID}?view=players`);
        const attendance = page
          .locator('section.card')
          .filter({ has: page.getByRole('heading', { name: 'Attendance changes', exact: true }) });
        const acknowledgement = attendance.getByRole('checkbox', { name: /Challonge bracket/ });
        const preview = attendance.getByRole('button', { name: 'Preview attendance change' });
        const apply = attendance.getByRole('button', { name: 'Apply this change' });
        await expect(attendance).toBeVisible();
        await ready(page);
        await chooseAttendanceOption(
          attendance.getByRole('combobox', { name: 'Change', exact: true }),
          'withdraw',
        );
        const player = attendance.getByRole('combobox', { name: 'Player', exact: true });
        await chooseAttendanceOption(player, entrant.id);
        await expect(player).toContainText(entrant.name);
        await expect(acknowledgement).toHaveCount(0);
        await preview.press('Enter');
        await expect(attendance.getByRole('heading', { name: 'Change preview' })).toBeVisible();
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

        if (linked) {
          await expect(apply).toBeDisabled();
          await preview.focus();
          await page.keyboard.press('Tab');
          await expect(acknowledgement).toBeFocused();
        } else {
          await expect(acknowledgement).toHaveCount(0);
          await expect(apply).toBeEnabled();
        }
        await page.evaluate(() => scrollTo(0, 0));
        await ready(page);
        await page.screenshot({
          path: testInfo.outputPath('attendance-preview.png'),
          fullPage: true,
        });
        if (linked) {
          await acknowledgement.press('Space');
          await expect(apply).toBeEnabled();
        }
        const submitted = page.waitForRequest((request) =>
          request.url().includes('eventOps.applyAttendance'),
        );
        await apply.click();
        const request = await submitted;
        const body = request.postDataJSON();
        const input = new URL(request.url()).searchParams.has('batch') ? body[0] : body;
        expect(input).toMatchObject({ playerId: entrant.id, revisionToken });
        expect(input.acknowledgeExternalChange).toBe(linked ? true : undefined);
        await expect(attendance.getByRole('status')).toContainText('Attendance updated');
        expect(fixture.unexpected).toEqual([]);
      });
    }
  }
}

test('each new relocation preview needs fresh approval while a no-show can stay in its pool', async ({
  page,
}) => {
  const fixture = await mockEvent(page, { role: 'admin' });
  const entrant = fixture.overview.entrants[0]!;
  const response = {
    allowed: true,
    issues: [],
    warnings: [],
    requiresExternalAcknowledgement: false,
    requiresRedistributionApproval: true,
    affectedMatches: [],
    addedMatches: 0,
    relocations: [{ playerId: entrant.id, fromPoolIndex: 0, toPoolIndex: 1 }],
    revisionToken: 'first-relocation',
  };
  fixture.responses['eventOps.previewAttendance'] = response;
  fixture.responses['eventOps.applyAttendance'] = { ok: true };

  await page.goto(`/operate/${PLAN_ID}?view=players`);
  const attendance = page.locator('section.card').filter({
    has: page.getByRole('heading', { name: 'Attendance changes', exact: true }),
  });
  const change = attendance.getByRole('combobox', { name: 'Change', exact: true });
  const player = attendance.getByRole('combobox', { name: 'Player', exact: true });
  const preview = attendance.getByRole('button', { name: 'Preview attendance change' });
  const apply = attendance.getByRole('button', { name: 'Apply this change' });
  const approval = attendance.getByRole('checkbox', { name: /I approve moving these players/ });
  await expect(attendance).toBeVisible();
  await ready(page);
  await chooseAttendanceOption(change, 'redistribute');
  await chooseAttendanceOption(player, entrant.id);
  await preview.click();
  await expect(attendance.getByText(/Pool A → Pool B/)).toBeVisible();
  await approval.check();
  await expect(apply).toBeEnabled();

  fixture.responses['eventOps.previewAttendance'] = {
    ...response,
    relocations: [{ playerId: entrant.id, fromPoolIndex: 0, toPoolIndex: 2 }],
    revisionToken: 'updated-relocation',
  };
  await preview.click();
  await expect(attendance.getByText(/Pool A → Pool C/)).toBeVisible();
  await expect(approval).not.toBeChecked();
  await expect(apply).toBeDisabled();
  await approval.check();
  await page.route('**/api/trpc/eventOps.applyAttendance*', (route) => route.abort(), { times: 1 });
  await apply.click();
  await expect(attendance.getByRole('alert')).toBeVisible();
  await expect(approval).toBeChecked();
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(attendance.getByRole('status')).toContainText('Attendance updated');

  await chooseAttendanceOption(change, 'no_show');
  await chooseAttendanceOption(player, entrant.id);
  await preview.click();
  await expect(approval).not.toBeChecked();
  await expect(approval).toHaveAccessibleName(/keep the two-player pool for now/);
  await expect(apply).toBeEnabled();
});
