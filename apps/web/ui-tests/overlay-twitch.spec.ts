import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mockEvent, PLAN_ID, ready } from './fixtures';

const channel = 'sydney_smash_tournament01';
const canonical = `twitch.tv/${channel}`;
const twitchLink = (page: Page) => page.getByRole('link', { name: /^twitch\.tv\// });
const sourcePath = (params: Record<string, string>) =>
  `/overlay/${PLAN_ID}?${new URLSearchParams(params)}`;

async function expectReadable(link: Locator) {
  await expect(link).toBeVisible();
  await expect(link).toBeInViewport({ ratio: 1 });
  await expect
    .poll(() =>
      link.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const parent = element.parentElement!.getBoundingClientRect();
        return (
          bounds.left >= parent.left &&
          bounds.right <= parent.right &&
          bounds.top >= parent.top &&
          bounds.bottom <= parent.bottom &&
          element.scrollWidth <= element.clientWidth &&
          element.contains(
            document.elementFromPoint(
              bounds.left + bounds.width / 2,
              bounds.top + bounds.height / 2,
            ),
          )
        );
      }),
    )
    .toBe(true);
}

function watchTwitchRequests(page: Page) {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (/(^|\.)twitch\.tv$/.test(new URL(request.url()).hostname)) requests.push(request.url());
  });
  return requests;
}

for (const [width, height, fontSize] of [
  [640, 360, 12],
  [1280, 720, 24],
  [1920, 1080, 36],
] as const)
  test(`Twitch link fits Gameplay and Progress at ${width} × ${height}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height });
    const requests = watchTwitchRequests(page);
    const { snapshot, unexpected } = await mockEvent(page);
    const station = snapshot.stations.find(({ name }) => name === 'Stage')!;
    station.name = 'Main stage with a deliberately long station name for OBS';
    const params = { twitch: channel, station: station.id };
    await page.goto(
      sourcePath({
        ...params,
        presentation: 'gameplay',
        ...(width === 1280 ? { controls: '0' } : {}),
      }),
    );
    const link = twitchLink(page);
    await ready(page);
    await expectReadable(link);
    await expect(link.locator('.broadcast-twitch-url')).toBeVisible();
    await expect(link.locator('.broadcast-twitch-url')).toHaveText(canonical);
    expect(
      await link.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
    ).toBeGreaterThanOrEqual(fontSize);
    await expect(link).toHaveAttribute('href', `https://www.twitch.tv/${channel}`);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(page.getByRole('region', { name: 'Transparent game capture area' })).toBeVisible();
    const setup = page.getByRole('button', { name: 'Display setup' });
    await page.keyboard.press('Tab');
    await expect(link).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    if (width === 1280) await expect(setup).toHaveCount(0);
    else {
      await expect(setup).toBeVisible();
      expect((await link.boundingBox())!.x + (await link.boundingBox())!.width).toBeLessThan(
        (await setup.boundingBox())!.x,
      );
    }
    await page.screenshot({
      path: testInfo.outputPath('twitch-gameplay.png'),
      omitBackground: true,
    });

    await page.goto(sourcePath({ ...params, presentation: 'progress', controls: '0' }));
    await expect(page.getByRole('region', { name: 'Tournament progress' })).toBeVisible();
    await expectReadable(link);
    await expect(link.locator('.broadcast-twitch-url')).toBeVisible();
    await expect(link.locator('.broadcast-twitch-url')).toHaveText(canonical);
    expect(
      await link.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
    ).toBeGreaterThanOrEqual(fontSize);
    await expect(page.getByRole('button', { name: 'Next page' })).toHaveCount(0);
    expect(
      (
        await new AxeBuilder({ page })
          .include('.broadcast-twitch-link')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('twitch-progress.png') });
    expect(requests).toEqual([]);
    expect(unexpected).toEqual([]);
  });

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440]) {
    test(`Display setup saves, reloads and clears the Twitch link at ${width}px in ${theme} by keyboard`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const requests = watchTwitchRequests(page);
      const { snapshot, unexpected } = await mockEvent(page, { idle: true });
      const params = {
        station: snapshot.stations[0]!.id,
        presentation: 'auto',
        cycleSeconds: '60',
        controls: '0',
        captureWidth: '71',
        captureHeight: '70',
      };
      await page.goto(sourcePath(params));
      await expect(page.getByRole('region', { name: 'Tournament progress' })).toBeVisible();
      const link = twitchLink(page);
      await expect(link).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Display setup' })).toHaveCount(0);
      await page.keyboard.press('s');
      const dialog = page.getByRole('dialog', { name: 'Display setup' });
      const input = dialog.getByRole('textbox', { name: 'Twitch channel (optional)' });
      await expect(input).toHaveValue('');
      await input.fill('https://www.twitch.tv.evil.test/redirect');
      await input.press('Enter');
      await expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(new URL(page.url()).searchParams.get('twitch')).toBeNull();
      await input.fill('https://www.twitch.tv/Sydney_Smash_Tournament01/?tt_content=link');
      await input.press('Enter');
      await expect(
        dialog.getByRole('status').filter({ hasText: /Twitch link saved/ }),
      ).toBeVisible();
      await expect(input).toHaveValue(channel);
      expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual({
        ...params,
        twitch: channel,
      });
      await ready(page);
      expect(
        (
          await new AxeBuilder({ page })
            .include('.overlay-setup')
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      await dialog
        .getByRole('textbox', { name: 'Twitch channel (optional)' })
        .scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath('twitch-display-setup.png') });
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expectReadable(link);

      await page.reload();
      await expectReadable(link);
      await page.keyboard.press('s');
      await expect(input).toHaveValue(channel);
      await input.fill('');
      await input.press('Enter');
      await expect(dialog.getByText('Twitch link removed.')).toBeVisible();
      expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual(params);
      await page.keyboard.press('Escape');
      await expect(link).toHaveCount(0);
      await page.reload();
      await expect(link).toHaveCount(0);

      await page.goto(
        sourcePath({
          ...params,
          presentation: 'gameplay',
          twitch: channel,
          ...(width === 390 ? { controls: '1' } : {}),
        }),
      );
      await ready(page);
      await expectReadable(link);
      if (width === 390) {
        const compact = link.locator('.broadcast-twitch-short');
        await expect(compact).toBeVisible();
        await expect(compact).toHaveText(`@${channel}`);
        const setup = page.getByRole('button', { name: 'Display setup' });
        await expect(setup).toBeVisible();
        expect((await link.boundingBox())!.x + (await link.boundingBox())!.width).toBeLessThan(
          (await setup.boundingBox())!.x,
        );
      }
      await page.screenshot({
        path: testInfo.outputPath('twitch-gameplay-compact.png'),
        omitBackground: true,
      });
      if (width === 390 && theme === 'dark') {
        await page.setViewportSize({ width: 320, height: 568 });
        await ready(page);
        await expectReadable(link);
        const status = page.locator('.broadcast-topline > span:first-child');
        await expect(status).toContainText('WAITING FOR A MATCH');
        expect(await status.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
          true,
        );
        await page.screenshot({
          path: testInfo.outputPath('twitch-gameplay-320.png'),
          omitBackground: true,
        });
      }
      await page.goto(sourcePath({ ...params, twitch: 'javascript:alert(1)' }));
      await expect(page.getByRole('region', { name: 'Tournament progress' })).toBeVisible();
      await expect(link).toHaveCount(0);
      await expect(page.locator('iframe')).toHaveCount(0);
      expect(requests).toEqual([]);
      expect(unexpected).toEqual([]);
    });
  }
