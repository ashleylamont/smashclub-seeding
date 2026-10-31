import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { bracketFixture, TEAM_ALIAS } from '../test/fixtures/brackets';
import { bracketCaptureOptions, mockEvent, PLAN_ID, ready } from './fixtures';

async function nativeDraw(page: Page, double = true) {
  const fixture = await mockEvent(page, { role: 'admin', bracket: true });
  const matches = bracketFixture(7, double).map((match) => ({
    ...fixture.snapshot.matches[0]!,
    ...match,
    liveScore1: null,
    liveScore2: null,
    availability: { canStart: false, reasons: [], eligibleStationIds: [] },
  }));
  Object.assign(fixture.snapshot.plan, {
    bracketMode: 'native',
    structure: double ? 'double_elimination' : 'single_elimination',
    drawPaused: true,
  });
  const draw = {
    matches,
    stationQueues: [],
    poolRounds: [],
    poolSchedules: [],
    nativeBrackets: [
      {
        id: 'rehearsal',
        division: 'upper',
        stage: 'main',
        entrantIds: Array.from({ length: 7 }, (_, i) => `entrant-${i}`),
        complete: false,
        winnerId: null,
        standings: [],
      },
    ],
    entrants: Array.from({ length: 7 }, (_, i) => ({
      id: `entrant-${i}`,
      name: i === 0 ? TEAM_ALIAS : `Entrant ${i + 1}`,
    })),
  };
  Object.assign(fixture.snapshot, draw);
  Object.assign(fixture.overview, draw);
  return { fixture, matches };
}

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test(`${theme} ${width}px TO draw and paper preview reuse the app bracket without writes`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const { fixture, matches } = await nativeDraw(page);
      await page.goto(`/operate/${PLAN_ID}?view=draw`);
      const draw = page.getByRole('region', { name: 'Tournament draw', exact: true });
      await expect(draw.locator('.event-bracket-match')).toHaveCount(matches.length);
      await expect(
        draw.getByRole('heading', { name: 'Losers bracket', exact: true }),
      ).toBeVisible();
      await expect(draw).toContainText('Reset final · If needed');
      await expect(draw).toContainText('1 TO worksheet');
      await expect(page.getByRole('button', { name: 'Finalize native results' })).toBeDisabled();
      await ready(page);
      expect(
        (
          await new AxeBuilder({ page })
            .include('.ops-page')
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.mouse.move(0, 0);
      await draw.screenshot({
        ...bracketCaptureOptions,
        path: testInfo.outputPath(`to-draw-${theme}-${width}.png`),
      });
      const print = draw.getByRole('button', { name: 'Print bracket backup sheets', exact: true });
      await print.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Print bracket backup sheets' });
      await expect(dialog.locator('.bracket-backup-page')).toHaveCount(1);
      await expect(
        dialog.getByRole('checkbox', { name: 'Open Championship', exact: true }),
      ).toBeChecked();
      await expect(dialog).toContainText('Loser of winners');
      await expect(dialog).toContainText('If needed');
      expect(
        (
          await new AxeBuilder({ page })
            .include('.bracket-backup-dialog')
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`print-preview-${theme}-${width}.png`) });
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
      await expect(print).toBeFocused();
      await expect(page.locator('body')).not.toHaveClass(/printing-bracket-backups/);
      await page.reload();
      await expect(draw.locator('.event-bracket-match')).toHaveCount(matches.length);
      await ready(page);
      await page.mouse.move(0, 0);
      await expect(draw).toHaveScreenshot(`to-draw-${theme}-${width}.png`, bracketCaptureOptions);
      expect(fixture.unexpected).toEqual([]);
    });

test('TO draw tools distinguish single draws, pool templates, unlocked knockouts and round robin', async ({
  page,
}) => {
  const { fixture, matches } = await nativeDraw(page, false);
  await page.goto(`/operate/${PLAN_ID}?view=draw`);
  const draw = page.getByRole('region', { name: 'Tournament draw', exact: true });
  await expect(draw.locator('.event-bracket-match')).toHaveCount(matches.length);
  await expect(draw.getByRole('heading', { name: 'Losers bracket', exact: true })).toHaveCount(0);
  await expect(draw).toContainText('1 TO worksheet');
  fixture.snapshot.nativeBrackets.length = 0;
  fixture.snapshot.matches.length = 0;
  await page.reload();
  await expect(draw).toContainText('Lock the draw in the planner');
  await expect(draw.getByRole('button', { name: 'Print bracket backup sheets' })).toHaveCount(0);
  Object.assign(fixture.snapshot.plan, { structure: 'dual_division' });
  await page.reload();
  await expect(draw).toContainText('Finals are not created yet');
  await expect(draw).toContainText('4 TO worksheets');
  await draw.getByRole('button', { name: 'Print bracket backup sheets' }).click();
  const dialog = page.getByRole('dialog', { name: 'Print bracket backup sheets' });
  await expect(dialog.locator('.bracket-backup-page')).toHaveCount(4);
  await expect(dialog).toContainText('Draw not generated yet');
  await page.keyboard.press('Escape');
  Object.assign(fixture.snapshot.plan, { structure: 'round_robin' });
  await page.reload();
  await expect(
    page.getByText('Round-robin events use the pool standings above;', { exact: false }),
  ).toBeVisible();
  await expect(draw).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Print bracket backup sheets' })).toHaveCount(0);
  expect(fixture.unexpected).toEqual([]);
});
