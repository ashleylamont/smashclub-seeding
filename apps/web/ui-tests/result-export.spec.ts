import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { mockEvent, PLAN_ID } from './fixtures';

test('actual downloaded results SVG keeps wide aliases inside the exported canvas', async ({
  page,
}, testInfo) => {
  const fixture = await mockEvent(page);
  fixture.snapshot.plan.name = 'W'.repeat(60);
  const placement = fixture.snapshot.placements[0]!;
  const entrant = fixture.snapshot.entrants.find((item) => item.id === placement.playerId)!;
  entrant.name = 'W'.repeat(48);
  await page.goto(`/live/${PLAN_ID}`);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download results graphic ↓' }).first().click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('smash-club-results.svg');
  const path = testInfo.outputPath('wide-alias-results.svg');
  await download.saveAs(path);
  const source = await readFile(path, 'utf8');
  expect(source).toContain(entrant.name);
  expect(source).not.toContain('canonicalName');
  const exported = await page.context().newPage();
  try {
    await exported.setViewportSize({ width: 1200, height: 900 });
    await exported.setContent(source);
    const bounds = await exported.locator('svg').evaluate((svg) => {
      const canvas = svg as SVGSVGElement;
      return [...svg.querySelectorAll('text')].map((text) => {
        const box = text.getBBox();
        return {
          text: text.textContent,
          left: box.x,
          right: box.x + box.width,
          bottom: box.y + box.height,
          height: canvas.viewBox.baseVal.height,
        };
      });
    });
    for (const box of bounds) {
      expect(box.left, box.text!).toBeGreaterThanOrEqual(0);
      expect(box.right, box.text!).toBeLessThanOrEqual(1152);
      expect(box.bottom, box.text!).toBeLessThanOrEqual(box.height);
    }
    await expect(exported.locator('svg')).toHaveScreenshot('export-wide-alias.png');
  } finally {
    await exported.close();
  }
  expect(fixture.unexpected).toEqual([]);
});
