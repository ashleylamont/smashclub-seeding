import { readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { chooseOption } from '../test-support/controls';
import { bracketCaptureOptions, mockEvent, PLAN_ID, ready } from './fixtures';

const captureStyle = readFileSync(bracketCaptureOptions.stylePath, 'utf8');

const sourceLabels = [
  ['auto', 'Automatic intermission overlay'],
  ['gameplay', 'Gameplay-only overlay'],
  ['progress', 'Progress-only overlay'],
] as const;

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test(`Broadcast copies the selected OBS source at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      const writes: string[] = [];
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      await page.clock.install({ time: new Date('2026-10-04T00:00:00Z') });
      const { overview, unexpected } = await mockEvent(page, { role: 'admin' });
      const [stage, setup] = overview.stations;
      const match = overview.matches.find((item) => item.id === stage?.currentMatchId);
      expect(match).toBeDefined();
      match!.player1Name = 'Alexandria with a long tournament alias from Western Sydney';

      let rejectClipboard = false;
      let holdClipboard = false;
      let releaseClipboard: (() => void) | undefined;
      await page.exposeFunction('writeObsSourceClipboard', async (value: string) => {
        writes.push(value);
        if (holdClipboard) await new Promise<void>((resolve) => (releaseClipboard = resolve));
        if (rejectClipboard) throw new Error('Clipboard access denied');
      });
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: (value: string) =>
              (
                window as unknown as {
                  writeObsSourceClipboard(value: string): Promise<void>;
                }
              ).writeObsSourceClipboard(value),
          },
        });
      });
      await page.goto(`/operate/${PLAN_ID}?view=broadcast&station=${stage!.id}`);
      const panel = page.getByRole('tabpanel', { name: 'Broadcast', exact: true });
      const disclosure = panel.getByRole('button', { name: 'Intermission browser sources' });
      await disclosure.press('Enter');
      await ready(page);
      await page.clock.pauseAt(new Date('2026-10-04T00:01:00Z'));
      const preview = (label: string) =>
        panel.getByRole('link', { name: `${label} ↗`, exact: true });
      const copy = (label: string, action = 'Copy') =>
        panel.getByRole('button', { name: `${action} ${label.toLowerCase()} URL`, exact: true });
      const automatic = sourceLabels[0][1];
      const gameplay = sourceLabels[1][1];
      const progress = sourceLabels[2][1];
      await page.keyboard.press('Tab');
      await expect(preview(automatic)).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(copy(automatic)).toBeFocused();

      const base = new URL(page.url()).origin;
      const urlFor = (mode: string, station: string) =>
        `/overlay/${PLAN_ID}?${new URLSearchParams({ station, presentation: mode, controls: '0' })}`;
      const autoUrl = base + urlFor('auto', stage!.id);
      for (const [mode, label] of sourceLabels)
        await expect(preview(label)).toHaveAttribute('href', urlFor(mode, stage!.id));
      await page.keyboard.press('Enter');
      await expect(copy(automatic, 'Copied')).toBeFocused();
      await expect(panel.getByText('Automatic intermission overlay URL copied.')).toHaveRole(
        'status',
      );
      expect(writes).toEqual([autoUrl]);
      await expect(copy(gameplay)).toBeVisible();
      await expect(copy(progress)).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      const copyCapture = testInfo.outputPath('copied.png');
      await page.screenshot({
        path: copyCapture,
        fullPage: true,
        animations: 'disabled',
        style: captureStyle,
      });
      await testInfo.attach('copied', {
        path: copyCapture,
        contentType: 'image/png',
      });

      await page.clock.runFor(1500);
      await copy(automatic, 'Copied').press('Space');
      await expect.poll(() => writes.length).toBe(2);
      await expect(copy(automatic, 'Copied')).toBeFocused();
      await page.clock.runFor(1500);
      await expect(copy(automatic, 'Copied')).toBeFocused();
      await page.clock.runFor(1500);
      await expect(copy(automatic)).toBeFocused();
      expect(writes).toEqual([autoUrl, autoUrl]);
      await page.clock.resume();

      const picker = panel.getByRole('combobox', { name: 'Station', exact: true });
      holdClipboard = true;
      await copy(gameplay).press('Enter');
      await expect.poll(() => releaseClipboard !== undefined).toBe(true);
      await expect(copy(gameplay, 'Copying')).toBeFocused();
      expect(writes.at(-1)).toBe(base + urlFor('gameplay', stage!.id));
      await chooseOption(picker, setup!.id);
      await expect(preview(gameplay)).toHaveAttribute('href', urlFor('gameplay', setup!.id));
      await expect(copy(gameplay)).toBeVisible();
      holdClipboard = false;
      releaseClipboard?.();
      await chooseOption(picker, stage!.id);
      await expect(copy(gameplay)).toBeVisible();
      await chooseOption(picker, setup!.id);

      rejectClipboard = true;
      await copy(progress).press('Enter');
      const fallback = panel.getByRole('textbox', { name: 'Progress-only overlay URL' });
      const progressUrl = base + urlFor('progress', setup!.id);
      await expect(fallback).toHaveValue(progressUrl);
      await expect(fallback).toHaveAttribute('readonly', '');
      expect(
        await fallback.evaluate(
          (input) =>
            input.scrollHeight <= input.clientHeight + 1 && input.scrollWidth <= input.clientWidth,
        ),
      ).toBe(true);
      await expect(copy(progress)).toBeFocused();
      await expect(panel.getByText('Could not copy the progress-only overlay URL.')).toHaveRole(
        'status',
      );
      expect(writes.at(-1)).toBe(progressUrl);
      await page.keyboard.press('Tab');
      await expect(fallback).toBeFocused();
      await page.keyboard.press('ControlOrMeta+a');
      expect(
        await fallback.evaluate((input: HTMLTextAreaElement) =>
          input.value.slice(input.selectionStart, input.selectionEnd),
        ),
      ).toBe(progressUrl);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
          .violations,
      ).toEqual([]);
      const fallbackCapture = testInfo.outputPath('manual-copy.png');
      await page.screenshot({
        path: fallbackCapture,
        fullPage: true,
        animations: 'disabled',
        style: captureStyle,
      });
      await testInfo.attach('manual-copy', {
        path: fallbackCapture,
        contentType: 'image/png',
      });

      await page.evaluate(() =>
        Object.defineProperty(navigator, 'clipboard', { value: undefined }),
      );
      await copy(gameplay).press('Enter');
      await expect(panel.getByRole('textbox', { name: 'Gameplay-only overlay URL' })).toHaveValue(
        base + urlFor('gameplay', setup!.id),
      );
      await expect(fallback).toBeHidden();
      await expect(preview(gameplay)).toHaveAttribute('target', '_blank');
      expect(unexpected).toEqual([]);
    });
