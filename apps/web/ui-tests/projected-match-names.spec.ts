import { readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { projectTournament, type ProjectionInput } from '../../server/src/event-planner/projection';
import { chooseOption } from '../test-support/controls';
import { rpcProcedures, rpcValue } from '../test-support/rpcBatch';
import { bracketCaptureOptions, mockEvent, ready } from './fixtures';

const captureStyle = readFileSync(bracketCaptureOptions.stylePath, 'utf8');

async function mockPlanner(page: Page) {
  const fixture = await mockEvent(page, { role: 'admin' });
  const procedure = 'admin.eventPlanner.projectTournament';
  await page.route(
    (url) => rpcProcedures(url.href).includes(procedure),
    async (route) => {
      const url = new URL(route.request().url());
      const input = rpcValue<ProjectionInput>(
        url.href,
        JSON.parse(url.searchParams.get('input')!),
        procedure,
      );
      const results = rpcProcedures(url.href).map((name) => {
        if (name === procedure) return { result: { data: projectTournament(input) } };
        expect(name in fixture.responses).toBe(true);
        return { result: { data: fixture.responses[name] } };
      });
      await route.fulfill({ json: url.searchParams.has('batch') ? results : results[0] });
    },
  );
  return fixture;
}

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test(`planner names fixed knockout positions at ${width}px in ${theme} mode`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const fixture = await mockPlanner(page);
      const writes: string[] = [];
      page.on('request', (request) => {
        if (request.method() === 'POST') writes.push(request.url());
      });
      await page.goto('/admin/event-planner');
      const preview = page.getByRole('region', { name: 'Tournament night preview' });
      await preview
        .getByRole('button', { name: 'Explore timeline, run order and brackets' })
        .press('Enter');
      const players = preview.getByLabel('Projected players');
      const format = preview.getByRole('combobox', { name: 'Detailed preview format' });
      const timeline = preview.getByRole('region', { name: 'Projected station timeline' });
      const timelineTab = preview.getByRole('tab', { name: 'Station timeline' });
      const layoutTab = preview.getByRole('tab', { name: 'Pools and bracket layout' });

      await players.fill('8');
      await preview.getByLabel('Preview start time').fill('18:30');
      await chooseOption(format, 'double_elimination');
      const semi = timeline.getByRole('button', { name: /^Winners semi-final 1 \(W SF 1\):/ });
      await semi.press('Enter');
      await expect(semi).toBeFocused();
      await expect(semi).toHaveText('W SF 1');
      await expect(preview.locator('.projection-inspector')).toContainText(
        'Winner of Winners quarter-final 1',
      );
      const sheetToggle = preview.getByRole('button', { name: 'Provisional run sheet and CSV' });
      const sheet = preview.getByRole('region', { name: 'Projected run sheet' });
      const previewRight = await preview.evaluate(
        (element) => element.getBoundingClientRect().right,
      );
      const withinPreview = async () => {
        for (const item of [preview.locator('.projection-inspector'), timeline, sheetToggle])
          expect(
            await item.evaluate((element) => element.getBoundingClientRect().right),
          ).toBeLessThanOrEqual(previewRight);
      };
      await withinPreview();
      await sheetToggle.press('Enter');
      await withinPreview();
      expect(
        await sheet.evaluate((element) => element.getBoundingClientRect().right),
      ).toBeLessThanOrEqual(previewRight);
      if (width === 390) {
        for (const scroll of [timeline, sheet]) {
          expect(await scroll.evaluate((element) => element.scrollWidth)).toBeGreaterThan(
            await scroll.evaluate((element) => element.clientWidth),
          );
        }
      }
      await expect(
        sheet.getByRole('cell', { name: 'Reset final (if needed)', exact: true }),
      ).toBeVisible();
      await expect(
        sheet.getByRole('cell', { name: 'Winners semi-final 1', exact: true }),
      ).toBeVisible();
      const download = preview.getByRole('link', { name: 'Download projected run sheet' });
      const csv = decodeURIComponent((await download.getAttribute('href'))!.split(',')[1]!);
      expect(csv.split('\r\n')[0]).toBe(
        '"Set","Stage","Station","Start","End","Side A","Side B","After"',
      );
      expect(csv).toContain(
        '"W2.1","Open championship · Winners round 2, set 1","3","18:42","18:52","Winner W1.1","Winner W1.2","W1.1 / W1.2"',
      );
      expect(csv).toContain('"Reset final","Open championship · Reset final (if needed)"');
      const namedDownload = preview.getByRole('link', {
        name: 'Download run sheet with match names',
      });
      const namedCsv = decodeURIComponent(
        (await namedDownload.getAttribute('href'))!.split(',')[1]!,
      );
      expect(namedCsv).toContain(
        '"Winners semi-final 1","Open championship","3","18:42","18:52","Winner of Winners quarter-final 1","Winner of Winners quarter-final 2","Winners quarter-final 1 / Winners quarter-final 2","W2.1","W1.1 / W1.2"',
      );
      expect(namedCsv).toContain('"Reset final (if needed)","Open championship"');
      const [namedFile] = await Promise.all([
        page.waitForEvent('download'),
        namedDownload.press('Enter'),
      ]);
      expect(namedFile.suggestedFilename()).toBe('tournament-projection-named.csv');
      await ready(page);
      await preview.screenshot({
        style: captureStyle,
        path: testInfo.outputPath('named-run-sheet.png'),
      });
      await layoutTab.press('Enter');
      const finals = preview.getByRole('region', { name: 'Grand final and reset layout' });
      const reset = finals.getByRole('article', { name: /^Reset final \(if needed\):/ });
      await expect(reset).toContainText('If needed');
      await ready(page);
      await preview.screenshot({
        style: captureStyle,
        path: testInfo.outputPath('named-double-elimination.png'),
      });
      if (width === 390) {
        await reset.scrollIntoViewIfNeeded();
        await expect(reset).toBeInViewport();
        await finals.screenshot({ path: testInfo.outputPath('named-reset-phone.png') });
      }

      await players.fill('5');
      await chooseOption(format, 'single_elimination');
      const single = preview.getByRole('region', { name: 'Open championship bracket' });
      await expect(single.getByText('Quarter-final 1 · Bye', { exact: true })).toBeVisible();
      await expect(single.getByText('Winner of Quarter-final 1', { exact: true })).toBeVisible();
      await expect(single.getByText('Final', { exact: true })).toBeVisible();
      await expect(single.getByText(/OM-/)).toHaveCount(0);
      expect(
        await single.locator('svg g').evaluateAll((nodes) =>
          nodes.every((node) => {
            const card = node.querySelector('rect')!.getBBox();
            return [...node.querySelectorAll('text')].every((label) => {
              const text = label.getBBox();
              return text.x + text.width < card.x + card.width;
            });
          }),
        ),
      ).toBe(true);
      await ready(page);
      await preview.screenshot({
        style: captureStyle,
        path: testInfo.outputPath('named-single-elimination.png'),
      });
      if (width === 390) {
        const final = single.getByText('Final', { exact: true });
        await final.scrollIntoViewIfNeeded();
        await expect(final).toBeInViewport();
        await single.screenshot({ path: testInfo.outputPath('named-final-phone.png') });
      }

      await timelineTab.press('Enter');
      const finalBar = timeline.getByRole('button', { name: /^Final:/ });
      await finalBar.press('Enter');
      await expect(finalBar).toBeFocused();
      await expect(finalBar).toHaveText('Final');
      await expect(preview.locator('.projection-inspector')).toContainText(
        'Winner of Semi-final 1 vs Winner of Semi-final 2',
      );
      await sheetToggle.press('Enter');
      await expect(
        sheet
          .getByRole('row')
          .filter({ has: page.getByRole('cell', { name: 'Semi-final 1', exact: true }) }),
      ).toContainText('Quarter-final 1 (bye), Quarter-final 2');
      await expect(
        sheet
          .getByRole('row')
          .filter({ has: page.getByRole('cell', { name: 'Final', exact: true }) }),
      ).toContainText('Semi-final 1, Semi-final 2');

      await layoutTab.press('Enter');
      await players.fill('17');
      await chooseOption(format, 'dual_division');
      await preview.getByRole('button', { name: 'Timing and division assumptions' }).press('Enter');
      await preview.getByLabel('Upper size (blank = even split)').fill('10');
      const upper = preview.getByRole('region', { name: 'Upper championship bracket' });
      const lower = preview.getByRole('region', { name: 'Lower consolation bracket' });
      await expect(upper.getByRole('img', { name: /6 qualifiers, 3 rounds/ })).toBeVisible();
      await expect(lower.getByRole('img', { name: /3 qualifiers, 2 rounds/ })).toBeVisible();
      await expect(upper.getByText('Quarter-final 1 · Bye', { exact: true })).toBeVisible();
      await expect(lower.getByText('Semi-final 1 · Bye', { exact: true })).toBeVisible();
      await timelineTab.press('Enter');
      const championshipSemi = timeline.getByRole('button', {
        name: /^Semi-final 1 · Upper championship \(SF 1 U champ\):/,
      });
      const consolationSemi = timeline.getByRole('button', {
        name: /^Semi-final 1 · Upper consolation \(SF 1 U cons\):/,
      });
      await expect(championshipSemi.locator('span')).toHaveText(['SF 1', 'U champ']);
      await expect(consolationSemi.locator('span')).toHaveText(['SF 1', 'U cons']);
      await expect(consolationSemi).toHaveAccessibleName(
        /Upper pool A · place 3 versus Upper pool C · place 4/,
      );
      const poolSet = timeline.getByRole('button', { name: /^Round 1, set 1 · Upper pool C/ });
      await expect(poolSet.locator('span')).toHaveText(['R1 S1', 'U pool C']);
      await championshipSemi.press('Enter');
      await expect(preview.locator('.projection-inspector')).toContainText(
        'Semi-final 1 · Upper championship',
      );
      await sheetToggle.press('Enter');
      const upperPoolRow = sheet
        .getByRole('row')
        .filter({ hasText: 'Upper pool C' })
        .filter({ has: page.getByRole('cell', { name: 'Round 1, set 1', exact: true }) });
      await expect(upperPoolRow).toHaveCount(1);
      await expect(
        sheet.getByRole('cell', { name: 'Upper pool A · place 3 vs Upper pool C · place 4' }),
      ).toBeVisible();
      const mixedCsv = decodeURIComponent((await download.getAttribute('href'))!.split(',')[1]!);
      expect(mixedCsv).toContain('"UA3","UC4"');
      const mixedNamedCsv = decodeURIComponent(
        (await namedDownload.getAttribute('href'))!.split(',')[1]!,
      );
      expect(mixedNamedCsv).toContain('"Upper pool A · place 3","Upper pool C · place 4"');
      await ready(page);
      for (const bar of [poolSet, championshipSemi, consolationSemi]) {
        expect(
          await bar
            .locator('span')
            .evaluateAll((lines) => lines.every((line) => line.scrollWidth <= line.clientWidth)),
        ).toBe(true);
      }
      await championshipSemi.scrollIntoViewIfNeeded();
      await timeline.screenshot({
        style: captureStyle,
        path: testInfo.outputPath('mixed-finals-bars.png'),
      });
      await timeline.evaluate((element) => (element.scrollLeft = 0));
      await preview.screenshot({
        style: captureStyle,
        path: testInfo.outputPath('named-mixed-timeline.png'),
      });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(
        (
          await new AxeBuilder({ page })
            .include('.planner-projection')
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      expect(writes).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({
        path: testInfo.outputPath('named-uneven-planner.png'),
        fullPage: true,
      });
    });
