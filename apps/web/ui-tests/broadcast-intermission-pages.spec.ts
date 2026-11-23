import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mockEvent, PLAN_ID, ready } from './fixtures';

const path = `/overlay/${PLAN_ID}`;

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test(`intermission page choice stays with the copied source at ${width}px in ${theme}`, async ({
      page,
      context,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((theme) => localStorage.setItem('smashclub:theme', theme), theme);
      const fixture = await mockEvent(page, { idle: true, bracket: true });
      const standings = fixture.snapshot.matches.find(
        (match) => match.stage === 'group' && match.status === 'complete' && match.player2Id,
      )!;
      const alias = 'A very long tournament alias from Western Sydney';
      Object.assign(standings, {
        player1Name: alias,
        outcome: 'played',
        winnerId: standings.player1Id,
        score1: 2,
        score2: 1,
        resultUpdatedAt: '2026-10-04T05:00:00.000Z',
      });
      const snapshot = { ...fixture.snapshot, broadcastPresentationMode: 'progress' };
      fixture.responses['eventOps.snapshot'] = snapshot;
      const station = fixture.snapshot.stations.find(({ name }) => name === 'Stage')!;
      const settings = { station: station.id, presentation: 'event', cycleSeconds: '30' };
      const writes: string[] = [];
      await page.exposeFunction('writeIntermissionClipboard', (value: string) =>
        writes.push(value),
      );
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: (value: string) =>
              (
                window as unknown as {
                  writeIntermissionClipboard(value: string): Promise<void>;
                }
              ).writeIntermissionClipboard(value),
          },
        });
      });

      await page.goto(
        `${path}?${new URLSearchParams(settings)}&controls=preview&debug=ignored#preview`,
      );
      const progress = page.getByRole('region', { name: 'Tournament progress', exact: true });
      const recent = progress.getByRole('heading', { name: 'Recent results', exact: true });
      const setup = page.getByRole('button', { name: 'Display setup', exact: true });
      const dialog = page.getByRole('dialog', { name: 'Display setup', exact: true });
      const pages = dialog.getByRole('combobox', { name: 'Intermission pages', exact: true });
      await expect(progress.getByText('Manual', { exact: true })).toBeVisible();
      await setup.press('Enter');
      await expect(pages).toHaveAttribute('data-value', 'all');
      await pages.press('Enter');
      await expect(page.getByRole('option', { name: 'All pages', exact: true })).toBeFocused();
      await page.keyboard.press('End');
      await expect(page.getByRole('option', { name: 'Recent results', exact: true })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(pages).toHaveAttribute('data-value', 'recent');
      await expect(pages).toBeFocused();
      await expect(page).toHaveURL(/progressContent=recent#preview$/);
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
      await dialog.screenshot({ path: testInfo.outputPath('intermission-pages-setup.png') });

      await dialog.getByRole('button', { name: 'Copy OBS source URL' }).press('Enter');
      await expect(dialog.getByText('OBS source URL copied.')).toBeVisible();
      expect(writes).toHaveLength(1);
      const source = new URL(writes[0]!);
      expect(source.pathname).toBe(path);
      expect(source.hash).toBe('');
      expect(Object.fromEntries(source.searchParams)).toEqual({
        ...settings,
        progressContent: 'recent',
        controls: '0',
      });
      await page.keyboard.press('Escape');
      await expect(setup).toBeFocused();
      await expect(recent).toBeVisible();
      await expect(progress.getByText('Page 1 / 1', { exact: true })).toBeVisible();
      await expect(progress.getByText(alias, { exact: true }).first()).toBeVisible();
      await ready(page);
      await page.screenshot({ path: testInfo.outputPath('intermission-results-only.png') });

      if (width === 1440 && theme === 'dark') {
        const other = await context.newPage();
        const otherFixture = await mockEvent(other, { idle: true, bracket: true });
        await other.goto(`${path}?${new URLSearchParams(settings)}`);
        await expect(other.getByRole('button', { name: 'Next page' })).toBeVisible();
        expect(new URL(other.url()).searchParams.has('progressContent')).toBe(false);
        expect(otherFixture.unexpected).toEqual([]);
        await other.close();
      }

      await page.goto(source.href);
      await expect(recent).toBeVisible();
      await expect(setup).toHaveCount(0);
      await page.keyboard.press('s');
      await expect(pages).toHaveAttribute('data-value', 'recent');
      await pages.press('Enter');
      await expect(page.getByRole('option', { name: 'Recent results', exact: true })).toBeFocused();
      await page.keyboard.press('ArrowUp');
      await expect(
        page.getByRole('option', { name: 'Standings and brackets', exact: true }),
      ).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(pages).toHaveAttribute('data-value', 'standings');
      await page.keyboard.press('Escape');
      await expect(recent).toHaveCount(0);
      await expect(progress.getByText('Manual', { exact: true })).toBeVisible();
      await ready(page);
      await page.screenshot({ path: testInfo.outputPath('intermission-standings-only.png') });
      await page.keyboard.press('PageDown');
      await expect(progress.getByText(/^Page 2 \/ /)).toBeVisible();
      await expect(recent).toHaveCount(0);

      if (width === 1440 && theme === 'dark') {
        snapshot.broadcastPresentationMode = 'gameplay';
        await page.reload();
        await expect(progress).toHaveCount(0);
        await expect(page.getByLabel('Transparent game capture area')).toBeVisible();
        expect(new URL(page.url()).searchParams.get('progressContent')).toBe('standings');
      }

      expect(fixture.starts).toEqual([]);
      expect(fixture.submissions).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });

test('a source limited to recent results shows tournament progress while waiting for results', async ({
  page,
}) => {
  const fixture = await mockEvent(page, { idle: true, bracket: true });
  fixture.snapshot.matches = fixture.snapshot.matches.filter(({ status }) => status !== 'complete');
  await page.goto(`${path}?presentation=progress&progressContent=recent`);
  const progress = page.getByRole('region', { name: 'Tournament progress', exact: true });
  await expect(
    progress.getByRole('heading', { name: 'Tournament progress', exact: true }),
  ).toBeVisible();
  await expect(progress.getByText('Page 1 / 1', { exact: true })).toBeVisible();
  await expect(progress.getByText('Event info & results', { exact: false })).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
});
