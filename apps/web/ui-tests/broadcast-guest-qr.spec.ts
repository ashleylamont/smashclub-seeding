import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mockEvent, PLAN_ID, ready } from './fixtures';

const path = `/overlay/${PLAN_ID}`;
const invitation = { token: 'fixture-guest-pass', expiresAt: null };
const qrName = 'Scan to report a match score';
const switchName = 'Show score-reporting QR on this source';

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test(`Display setup hides the guest QR on one source at ${width}px in ${theme}`, async ({
      page,
      context,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((theme) => localStorage.setItem('smashclub:theme', theme), theme);
      const fixture = await mockEvent(page);
      fixture.responses['eventOps.guests.overlayInvitation'] = invitation;
      const stage = fixture.snapshot.stations.find((item) => item.name === 'Stage')!;
      const match = fixture.snapshot.matches.find(
        (item) => item.status === 'playing' && item.stationId === stage.id,
      )!;
      const settings = {
        station: stage.id,
        presentation: 'event',
        recent: '1',
        cycleSeconds: '30',
        controls: 'preview',
      };
      const writes: string[] = [];
      await page.exposeFunction('writeGuestSetupClipboard', (value: string) => writes.push(value));
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: (value: string) =>
              (
                window as unknown as {
                  writeGuestSetupClipboard(value: string): Promise<void>;
                }
              ).writeGuestSetupClipboard(value),
          },
        });
      });

      await page.goto(`${path}?${new URLSearchParams(settings)}&debug=ignored#preview`);
      const qr = page.getByRole('img', { name: qrName });
      const rail = page.locator('.broadcast-rail');
      const setup = page.getByRole('button', { name: 'Display setup', exact: true });
      const dialog = page.getByRole('dialog', { name: 'Display setup' });
      const showQr = dialog.getByRole('switch', { name: switchName });
      await expect(qr).toBeVisible();
      await expect(page.getByLabel('Current match')).toContainText(match.player1Name!);
      await setup.press('Enter');
      await expect(showQr).toBeChecked();
      await dialog
        .getByRole('combobox', { name: 'Recent results in the gameplay sidebar' })
        .focus();
      await page.keyboard.press('Tab');
      await expect(showQr).toBeFocused();
      await page.keyboard.press('Space');
      await expect(showQr).not.toBeChecked();
      await expect(showQr).toBeFocused();
      await expect(rail.locator('.broadcast-guest-pass')).toHaveCount(0);
      await expect(page).toHaveURL(/guestQr=0#preview$/);
      await ready(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(
        (
          await new AxeBuilder({ page })
            .include('.overlay-setup')
            .withTags(['wcag2a', 'wcag2aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      await dialog.screenshot({ path: testInfo.outputPath('qr-hidden-setting.png') });

      const copy = dialog.getByRole('button', { name: 'Copy OBS source URL' });
      await copy.press('Enter');
      await expect(
        dialog.getByRole('status').filter({ hasText: 'OBS source URL copied.' }),
      ).toBeVisible();
      expect(writes).toHaveLength(1);
      const source = new URL(writes[0]!);
      expect(source.pathname).toBe(path);
      expect(source.hash).toBe('');
      expect(Object.fromEntries(source.searchParams)).toEqual({
        ...settings,
        guestQr: '0',
        controls: '0',
      });

      if (width === 1440 && theme === 'dark') {
        const other = await context.newPage();
        const otherFixture = await mockEvent(other);
        otherFixture.responses['eventOps.guests.overlayInvitation'] = invitation;
        await other.goto(`${path}?${new URLSearchParams({ ...settings, controls: '0' })}`);
        await expect(other.getByRole('img', { name: qrName })).toBeVisible();
        expect(otherFixture.unexpected).toEqual([]);
        await other.close();
      }

      await page.keyboard.press('Escape');
      await expect(setup).toBeFocused();
      await page.goto(source.href);
      await expect(page.getByLabel('Current match')).toContainText(match.player1Name!);
      await expect(rail.locator('.broadcast-guest-pass')).toHaveCount(0);
      await expect(setup).toHaveCount(0);
      await ready(page);
      const aperture = (await page.getByLabel('Transparent game capture area').boundingBox())!;
      expect(
        await page.evaluate(
          ({ x, y }) =>
            document
              .elementsFromPoint(x, y)
              .every((element) =>
                ['transparent', 'rgba(0, 0, 0, 0)'].includes(
                  getComputedStyle(element).backgroundColor,
                ),
              ),
          { x: aperture.x + aperture.width / 2, y: aperture.y + aperture.height / 2 },
        ),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath('qr-hidden-source.png'),
        omitBackground: true,
      });
      await page.keyboard.press('s');
      await expect(showQr).not.toBeChecked();
      await showQr.press('Space');
      await expect(showQr).toBeChecked();
      expect(new URL(page.url()).searchParams.has('guestQr')).toBe(false);
      await dialog.screenshot({ path: testInfo.outputPath('qr-shown-setting.png') });
      await page.keyboard.press('Escape');
      await expect(qr).toBeVisible();
      await ready(page);
      await page.screenshot({
        path: testInfo.outputPath('qr-shown-source.png'),
        omitBackground: true,
      });
      expect(fixture.starts).toEqual([]);
      expect(fixture.submissions).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });

for (const status of ['unavailable', 'expired'] as const)
  test(`Show score-reporting QR respects an ${status} event invitation`, async ({ page }) => {
    const fixture = await mockEvent(page);
    if (status === 'expired')
      fixture.responses['eventOps.guests.overlayInvitation'] = {
        ...invitation,
        expiresAt: '2026-10-03T23:59:59Z',
      };
    const invitationResponse = page.waitForResponse((response) =>
      response.url().includes('eventOps.guests.overlayInvitation'),
    );
    await page.goto(`${path}?presentation=gameplay&controls=preview&guestQr=0&setup=1`);
    await invitationResponse;
    const toggle = page.getByRole('switch', { name: switchName });
    await expect(toggle).not.toBeChecked();
    await toggle.press('Space');
    await expect(toggle).toBeChecked();
    await page.keyboard.press('Escape');
    await ready(page);
    await expect(page.locator('.broadcast-guest-pass')).toHaveCount(0);
    expect(fixture.unexpected).toEqual([]);
  });
