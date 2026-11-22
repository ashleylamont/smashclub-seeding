import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { chooseOption } from '../test-support/controls';
import { mockEvent, PLAN_ID, ready } from './fixtures';

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test(`Display setup hands off a clean configured OBS source at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const { snapshot, unexpected } = await mockEvent(page, { idle: true });
      const [stage, setup] = snapshot.stations;
      const initialParams = {
        setup: '1',
        controls: '1',
        station: stage!.id,
        presentation: 'auto',
        captureWidth: '71',
        captureHeight: '70',
        recent: '1',
        pool: 'upper:0',
        token: 'synthetic-private-query',
      };
      const source = `/overlay/${PLAN_ID}?${new URLSearchParams(initialParams)}#synthetic-private-fragment`;
      let clipboard = '';
      let rejectClipboard = false;
      await page.exposeFunction('writeConfiguredObsUrl', (value: string) => {
        if (rejectClipboard) throw new Error('Clipboard access denied');
        clipboard = value;
      });
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'clipboard', {
          value: {
            writeText: (value: string) => Reflect.get(window, 'writeConfiguredObsUrl')(value),
          },
        });
      });
      await page.goto(source);
      const dialog = page.getByRole('dialog', { name: 'Display setup' });
      await chooseOption(
        dialog.getByRole('combobox', { name: 'Current match station' }),
        setup!.id,
      );
      await chooseOption(
        dialog.getByRole('combobox', { name: 'Broadcast presentation' }),
        'gameplay',
      );
      await chooseOption(
        dialog.getByRole('combobox', { name: 'Change progress page every' }),
        '30',
      );
      const twitch = dialog.getByRole('textbox', { name: 'Twitch channel (optional)' });
      await twitch.fill('https://www.twitch.tv/Sydney_Smash_Tournament01/');
      await twitch.press('Enter');
      const preview = new URL(page.url());
      expect(preview.searchParams.get('setup')).toBe('1');
      expect(preview.searchParams.get('controls')).toBe('1');
      expect(preview.searchParams.get('token')).toBe('synthetic-private-query');
      expect(preview.hash).toBe('#synthetic-private-fragment');
      const instructions = dialog.getByText('Add this URL as a Browser Source at 1920 × 1080.');
      await instructions.scrollIntoViewIfNeeded();
      await ready(page);
      await page.screenshot({ path: testInfo.outputPath('configured-display-setup.png') });

      const copy = dialog.getByRole('button', { name: 'Copy OBS source URL', exact: true });
      await expect(copy).toBeVisible();
      await copy.press('Enter');
      await expect(dialog.getByText('OBS source URL copied.')).toHaveRole('status');
      expect(clipboard).not.toBe('');
      const exported = new URL(clipboard);
      expect(exported.origin + exported.pathname).toBe(preview.origin + preview.pathname);
      expect(Object.fromEntries(exported.searchParams)).toEqual({
        controls: '0',
        station: setup!.id,
        presentation: 'gameplay',
        cycleSeconds: '30',
        captureWidth: '71',
        captureHeight: '70',
        recent: '1',
        pool: 'upper:0',
        twitch: 'sydney_smash_tournament01',
      });
      expect(exported.hash).toBe('');
      expect(page.url()).toBe(preview.href);
      await expect(copy).toBeFocused();
      await page.screenshot({ path: testInfo.outputPath('obs-source-copied.png') });

      rejectClipboard = true;
      await copy.press('Space');
      const manual = dialog.getByRole('textbox', { name: 'OBS source URL', exact: true });
      await expect(manual).toHaveValue(clipboard);
      await expect(manual).toHaveAttribute('readonly', '');
      await page.keyboard.press('Tab');
      await expect(manual).toBeFocused();
      await manual.press('ControlOrMeta+A');
      expect(
        await manual.evaluate((input: HTMLTextAreaElement) =>
          input.value.slice(input.selectionStart, input.selectionEnd),
        ),
      ).toBe(clipboard);
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      expect(
        (
          await new AxeBuilder({ page })
            .include('.overlay-setup')
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath('manually-copy-obs-source.png') });

      await page.goto(clipboard);
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Display setup' })).toHaveCount(0);
      await expect(
        page.getByRole('region', { name: 'Transparent game capture area' }),
      ).toBeVisible();
      await expect(page.locator('.broadcast-topline')).toContainText(setup!.name);
      await expect(
        page.getByRole('link', { name: /^twitch\.tv\/sydney_smash_tournament01/ }),
      ).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath('copied-obs-source.png'),
        omitBackground: true,
      });
      expect(unexpected).toEqual([]);
    });
