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
  ['event', 'Follow event overlay'],
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
      let clipboardContents = '';
      let releaseClipboard: (() => void) | undefined;
      await page.exposeFunction('writeObsSourceClipboard', async (value: string) => {
        writes.push(value);
        if (holdClipboard) {
          holdClipboard = false;
          await new Promise<void>((resolve) => (releaseClipboard = resolve));
        }
        if (rejectClipboard) throw new Error('Clipboard access denied');
        clipboardContents = value;
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
      const urlFor = (mode: string, station: string, controls = '0') =>
        `/overlay/${PLAN_ID}?${new URLSearchParams({ station, presentation: mode, controls })}`;
      const autoUrl = base + urlFor('auto', stage!.id);
      for (const [mode, label] of sourceLabels)
        await expect(preview(label)).toHaveAttribute('href', urlFor(mode, stage!.id, 'preview'));
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
      const gameplayUrl = base + urlFor('gameplay', stage!.id);
      const progressUrl = base + urlFor('progress', setup!.id);
      holdClipboard = true;
      await copy(gameplay).press('Enter');
      await expect.poll(() => releaseClipboard !== undefined).toBe(true);
      await expect(copy(gameplay, 'Copying')).toBeFocused();
      try {
        await copy(progress).press('Enter');
        await chooseOption(picker, setup!.id);
        await copy(progress).press('Space');
        await chooseOption(picker, stage!.id);
        await chooseOption(picker, setup!.id);
        expect(writes).toEqual([autoUrl, autoUrl, gameplayUrl]);
        expect(clipboardContents).toBe(autoUrl);
        await expect(copy(progress)).toBeDisabled();
        await expect(panel.getByText('Waiting for the previous copy to finish.')).toBeVisible();
        await page.screenshot({
          path: testInfo.outputPath('waiting-for-clipboard.png'),
          fullPage: true,
          animations: 'disabled',
          style: captureStyle,
        });
      } finally {
        releaseClipboard?.();
      }
      await expect(preview(gameplay)).toHaveAttribute(
        'href',
        urlFor('gameplay', setup!.id, 'preview'),
      );
      await expect(copy(gameplay)).toBeEnabled();
      await expect(panel.getByText('Waiting for the previous copy to finish.')).toBeHidden();
      expect(clipboardContents).toBe(gameplayUrl);
      await copy(progress).press('Enter');
      await expect(copy(progress, 'Copied')).toBeFocused();
      expect(clipboardContents).toBe(progressUrl);
      const following = sourceLabels[3][1];
      await copy(following).press('Enter');
      await expect(copy(following, 'Copied')).toBeFocused();
      expect(clipboardContents).toBe(base + urlFor('event', setup!.id));

      rejectClipboard = true;
      await copy(progress).press('Enter');
      const fallback = panel.getByRole('textbox', { name: 'Progress-only overlay URL' });
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

for (const width of [390, 1440]) {
  const phone = width === 390;
  test.describe(`OBS source preview at ${width}px`, () => {
    test.use({ hasTouch: phone, viewport: { width, height: phone ? 844 : 900 } });

    for (const theme of ['dark', 'light'] as const)
      test(`Follow event setup and copy in ${theme}`, async ({ page }, testInfo) => {
        await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
        const { snapshot, unexpected } = await mockEvent(page, { role: 'admin' });
        const [stage, floor] = snapshot.stations;
        snapshot.matches.find((match) => match.id === stage!.currentMatchId)!.player1Name =
          'Alexandria with a long tournament alias from Western Sydney';
        Object.assign(snapshot, { broadcastPresentationMode: 'gameplay' });
        let clipboard = '';
        await page.exposeFunction('copyPreviewSource', (value: string) => {
          clipboard = value;
        });
        await page.addInitScript(() => {
          Object.defineProperty(navigator, 'clipboard', {
            value: {
              writeText: (value: string) => Reflect.get(window, 'copyPreviewSource')(value),
            },
          });
        });

        await page.goto(`/operate/${PLAN_ID}?view=broadcast&station=${floor!.id}`);
        const panel = page.getByRole('tabpanel', { name: 'Broadcast', exact: true });
        const sources = panel.getByRole('button', { name: 'Intermission browser sources' });
        if (phone) await sources.tap();
        else await sources.press('Enter');
        const preview = panel.getByRole('link', { name: 'Follow event overlay ↗', exact: true });
        const href = (await preview.getAttribute('href'))!;
        const url = new URL(href, page.url());
        expect(url.searchParams.get('station')).toBe(floor!.id);
        expect(url.searchParams.get('presentation')).toBe('event');

        await page.goto(href);
        const setup = page.getByRole('button', { name: 'Display setup', exact: true });
        await expect(setup).toBeVisible();
        await ready(page);
        const box = (await setup.boundingBox())!;
        const appearance = await setup.evaluate((element) => {
          const { opacity, fontSize } = getComputedStyle(element);
          return { opacity: Number(opacity), fontSize: parseFloat(fontSize) };
        });
        expect(box.height).toBeGreaterThanOrEqual(phone ? 44 : 36);
        expect(appearance).toEqual({ opacity: 1, fontSize: 13 });
        const metadata = (await page.locator('.broadcast-topline').boundingBox())!;
        expect(box.y + box.height).toBeLessThanOrEqual(metadata.y);
        await page.screenshot({ path: testInfo.outputPath('editable-source-preview.png') });
        if (phone) await setup.tap();
        else await setup.press('Enter');
        const dialog = page.getByRole('dialog', { name: 'Display setup' });
        await expect(dialog.getByRole('combobox', { name: 'Current match station' })).toContainText(
          floor!.name,
        );
        await expect(
          dialog.getByRole('combobox', { name: 'Broadcast presentation' }),
        ).toContainText('Follow event');
        const timing = dialog.getByRole('combobox', { name: 'Change progress page every' });
        await expect(timing).toContainText('10 seconds');
        await chooseOption(timing, '30');

        const copy = dialog.getByRole('button', { name: 'Copy OBS source URL' });
        if (phone) await copy.tap();
        else await copy.press('Enter');
        await expect(dialog.getByRole('status')).toHaveText('OBS source URL copied.');
        expect(clipboard).toBe(
          `${url.origin}/overlay/${PLAN_ID}?station=${floor!.id}&presentation=event&cycleSeconds=30&controls=0`,
        );
        await ready(page);
        await page.screenshot({ path: testInfo.outputPath('configured-preview.png') });

        await page.goto(clipboard);
        await expect(
          page.getByRole('region', { name: 'Transparent game capture area' }),
        ).toBeVisible();
        await expect(setup).toHaveCount(0);
        await expect(dialog).toHaveCount(0);
        expect(unexpected).toEqual([]);
      });
  });
}
