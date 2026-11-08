import { readFile } from 'node:fs/promises';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { bracketFixture, TEAM_ALIAS } from '../test/fixtures/brackets';
import { mockEvent, PLAN_ID, ready } from './fixtures';

async function setup(page: Page, double: boolean, closed: boolean) {
  const fixture = await mockEvent(page, { bracket: true });
  const { snapshot } = fixture;
  const template = snapshot.matches.find((match) => match.nativeBracketId)!;
  const bracket = snapshot.nativeBrackets[0]!;
  const matches = bracketFixture(7, double);
  const played = matches.find((match) => match.status === 'ready')!;
  Object.assign(played, {
    status: 'complete',
    winnerId: played.player2Id,
    score1: 0,
    score2: 2,
    outcome: 'played',
    player1Name: `艾麗 & <Alex> ${TEAM_ALIAS}`,
  });
  snapshot.matches = [];
  snapshot.matches.push(
    ...matches.map((match) =>
      Object.assign({ ...template }, match, { nativeBracketId: bracket.id }),
    ),
  );
  Object.assign(snapshot.plan, {
    structure: double ? 'double_elimination' : 'single_elimination',
    competitionFormat: double ? 'doubles' : 'singles',
    status: closed ? 'complete' : 'underway',
    drawPaused: !closed && !double,
  });
  return fixture;
}

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test(`${theme} ${width}px public draw downloads a native bracket graphic`, async ({
      page,
    }, testInfo) => {
      const double = width === 1440;
      const closed = theme === 'light';
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const fixture = await setup(page, double, closed);
      const title = fixture.snapshot.plan.name;
      await page.goto(`/play/${PLAN_ID}`);
      const action = page.getByRole('button', {
        name: 'Preview bracket graphic for Open championship',
      });
      await expect(action).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Open · Championship' })).toBeVisible();
      await action.scrollIntoViewIfNeeded();
      await ready(page);
      await page.screenshot({ path: testInfo.outputPath('bracket-route.png') });
      await action.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Bracket graphic' });
      const preview = dialog.getByRole('region', { name: 'Scrollable bracket image preview' });
      const image = preview.getByRole('img', { name: `${title} · Open championship bracket` });
      await expect(image).toBeVisible();
      await expect
        .poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth))
        .toBeGreaterThan(0);
      await preview.focus();
      await expect(preview).toBeFocused();
      if (width === 390) {
        await page.keyboard.press('ArrowRight');
        await expect.poll(() => preview.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
        await preview.evaluate((node) => {
          node.scrollLeft = 0;
        });
      }
      await ready(page);
      await page.screenshot({ path: testInfo.outputPath('bracket-preview.png') });
      expect(
        (
          await new AxeBuilder({ page })
            .include('.ui-dialog')
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );

      if (double && closed) {
        fixture.snapshot.plan.name = 'Renamed live event';
        await expect(page.getByText('Renamed live event', { exact: true }).first()).toBeVisible();
        await expect(image).toBeVisible();
      }
      const pngEvent = page.waitForEvent('download');
      await dialog.getByRole('button', { name: 'Download bracket PNG' }).press('Enter');
      const png = await pngEvent;
      await png.saveAs(testInfo.outputPath('draw.png'));
      const pngBytes = await readFile(testInfo.outputPath('draw.png'));
      expect(pngBytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(pngBytes.readUInt32BE(16)).toBeLessThanOrEqual(4096);
      expect(pngBytes.readUInt32BE(20)).toBeLessThanOrEqual(4096);

      const svgEvent = page.waitForEvent('download');
      await dialog.getByRole('button', { name: 'Download bracket SVG' }).press('Enter');
      const svg = await svgEvent;
      expect(svg.suggestedFilename()).not.toContain('renamed');
      await svg.saveAs(testInfo.outputPath('draw.svg'));
      const bytes = await readFile(testInfo.outputPath('draw.svg'), 'utf8');
      expect(bytes).toContain('艾麗 &amp; &lt;Alex&gt;');
      expect(bytes).toContain(
        closed ? 'Recorded draw' : double ? 'Published draw snapshot' : 'Draw paused',
      );
      expect(bytes).toContain('>0</text>');
      expect(bytes).toContain('>2</text>');
      expect(bytes).toContain('Bye');
      expect(bytes).not.toMatch(/<script|<image|href=/);
      if (double) {
        expect(bytes).toContain('Losers bracket');
        expect(bytes).toContain('Reset · if needed');
        expect(bytes).toContain('Loser of winners');
      }
      const svgPage = await page.context().newPage();
      await svgPage.setContent(bytes);
      expect(
        await svgPage.locator('svg').evaluate((root) => {
          const bounds = root.getBoundingClientRect();
          return [...root.querySelectorAll('text')].every((text) => {
            const box = text.getBoundingClientRect();
            return (
              box.left >= bounds.left &&
              box.right <= bounds.right &&
              box.top >= bounds.top &&
              box.bottom <= bounds.bottom
            );
          });
        }),
      ).toBe(true);
      await svgPage.close();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(action).toBeFocused();
      expect(fixture.unexpected).toEqual([]);
    });

test('round robin, linked and incomplete native topology do not promise a bracket image', async ({
  page,
}) => {
  const fixture = await setup(page, false, false);
  const action = page.getByRole('button', { name: /Preview bracket graphic/ });
  const match = fixture.snapshot.matches.find(({ nativeBracketId }) => nativeBracketId)!;
  Object.assign(match, { parent1MatchId: 'missing-feeder' });
  await page.goto(`/play/${PLAN_ID}`);
  await expect(page.locator('.event-bracket-lane').first()).toBeVisible();
  await expect(action).toHaveCount(0);
  Object.assign(fixture.snapshot.plan, { structure: 'round_robin' });
  await page.goto(`/play/${PLAN_ID}`);
  await expect(page.getByText(/there is no finals bracket/)).toBeVisible();
  await expect(action).toHaveCount(0);
  Object.assign(fixture.snapshot.plan, { bracketMode: 'challonge', structure: 'pools_finals' });
  fixture.snapshot.nativeBrackets = [];
  Object.assign(fixture.snapshot.brackets[0]!, { slug: 'synthetic-linked-draw' });
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Challonge brackets' })).toBeVisible();
  await expect(action).toHaveCount(0);
});
