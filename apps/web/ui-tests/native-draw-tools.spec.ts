import { AxeBuilder } from '@axe-core/playwright';
import { buildRoundRobin } from '@smashclub/tournament-formats';
import { darwinBaseline, darwinScreenshot } from './darwinScreenshot';
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
    test(
      `${theme} ${width}px TO draw and paper preview reuse the app bracket without writes`,
      darwinBaseline,
      async ({ page }, testInfo) => {
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
        const print = draw.getByRole('button', {
          name: 'Print bracket backup sheets',
          exact: true,
        });
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
        await darwinScreenshot(draw, `to-draw-${theme}-${width}.png`, bracketCaptureOptions);
        expect(fixture.unexpected).toEqual([]);
      },
    );

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

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test(`blank nine-qualifier worksheet fits the draw at ${width}px in ${theme} mode`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const fixture = await mockEvent(page, { role: 'admin' });
      Object.assign(fixture.snapshot.plan, {
        structure: 'round_robin_finals',
        structureOptions: { roundRobinMeetings: 1, playoffSize: 9, consolation: false },
      });
      const entrants = Array.from({ length: 10 }, (_, index) => ({
        id: `entrant-${index + 1}`,
        name: index === 0 ? TEAM_ALIAS : `Entrant ${index + 1}`,
      }));
      const names = new Map(entrants.map(({ id, name }) => [id, name]));
      const matches = buildRoundRobin(entrants.map(({ id }) => id)).map((pair) => ({
        ...fixture.snapshot.matches[0]!,
        id: `pool-${pair.round}-${pair.slot}`,
        division: 'upper',
        player1Id: pair.player1Id,
        player2Id: pair.player2Id,
        player1Name: names.get(pair.player1Id)!,
        player2Name: names.get(pair.player2Id)!,
        score1: null,
        score2: null,
        winnerId: null,
        outcome: null,
        status: 'ready',
      }));
      const draft = { entrants, matches, stationQueues: [], poolRounds: [], poolSchedules: [] };
      Object.assign(fixture.snapshot, draft);
      Object.assign(fixture.overview, draft);
      const writes: string[] = [];
      page.on('request', (request) => {
        if (request.method() === 'POST') writes.push(request.url());
      });

      await page.goto(`/operate/${PLAN_ID}?view=draw`);
      const draw = page.getByRole('region', { name: 'Tournament draw', exact: true });
      await expect(draw).toContainText('1 TO worksheet');
      await ready(page);
      await page.screenshot({
        fullPage: true,
        path: testInfo.outputPath('blank-worksheet-route.png'),
      });
      const print = draw.getByRole('button', { name: 'Print bracket backup sheets' });
      await print.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Print bracket backup sheets' });
      const paper = dialog.locator('.bracket-backup-page');
      const rows = paper.locator('tbody tr');
      await expect(rows).toHaveCount(15);
      await expect(rows.first().getByRole('cell')).toHaveText([
        'Round of 16 1',
        '',
        '',
        '____ – ____Winner: ______________',
      ]);
      await expect(rows.nth(8)).toContainText('Winner of Round of 16 1');
      await expect(rows.last()).toContainText('Winner of Semi-final 1');
      await expect(paper).toContainText('estimated paper template');
      await expect(paper).toContainText(TEAM_ALIAS);
      await ready(page);
      expect(
        (
          await new AxeBuilder({ page })
            .include('.bracket-backup-dialog')
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      expect(await paper.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      await page.screenshot({ path: testInfo.outputPath('blank-worksheet-preview.png') });
      await rows.last().scrollIntoViewIfNeeded();
      await expect(rows.last()).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath('blank-worksheet-feeders.png') });
      if (width === 1440 && theme === 'light') {
        await page.emulateMedia({ media: 'print' });
        const pdf = await page.pdf({
          format: 'A4',
          preferCSSPageSize: true,
          path: testInfo.outputPath('blank-nine-qualifier-a4.pdf'),
        });
        expect(pdf.toString('latin1').match(/\/Type \/Page\b/g)).toHaveLength(1);
        await page.emulateMedia({ media: 'screen' });
      }
      await page.keyboard.press('Escape');
      await expect(print).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(writes).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
