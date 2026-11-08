import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
const data = JSON.parse(
  readFileSync(`${process.env.NEMESIS_RENDERER_PROBE_DIR}/tip12.json`, 'utf8'),
).result.data;
const edges = new Set<string>();
for (const m of data.matches)
  if (m.nativeBracketId)
    for (const [parent, side] of [
      [m.parent1MatchId, 0],
      [m.parent2MatchId, 1],
    ])
      if (parent) edges.add(`${parent}>${m.id}:${side}`);
for (const mode of ['original', 'current'])
  for (const width of [390, 1440]) {
    test(`TIP12 ${mode} ${width}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((snapshot) => {
        Object.assign(window, { tip12: snapshot });
      }, data);
      await page.goto(`/local-tip12-spike.html?renderer=${mode}`);
      const matches = page.locator('.event-bracket-match');
      await expect(matches).toHaveCount(52);
      expect(edges.size).toBe(48);
      const result = await page.evaluate(() => {
        const ids = [...document.querySelectorAll<HTMLElement>('.event-bracket-match')];
        return {
          cards: ids.length,
          stubSources: ids
            .filter((e) => getComputedStyle(e, '::after').content !== 'none')
            .map((e) => e.dataset.matchId),
          paths: [...document.querySelectorAll<SVGPathElement>('path[data-feed-from]')].map(
            (e) => `${e.dataset.feedFrom}>${e.dataset.feedTo}:${e.dataset.feedSide}`,
          ),
          scrollWidth: document.documentElement.scrollWidth,
        };
      });
      const sources = new Set([...edges].map((s) => s.split('>')[0]!));
      const withoutStub = [...sources].filter((s) => !result.stubSources.includes(s));
      const incorrectPaths = result.paths.filter((s) => !edges.has(s));
      const omittedPaths = [...edges].filter((s) => !result.paths.includes(s));
      console.log(
        JSON.stringify({
          mode,
          width,
          actualEdges: edges.size,
          cards: result.cards,
          stubSources: result.stubSources.length,
          actualSourceWithoutStub: withoutStub.length,
          paths: result.paths.length,
          incorrectPaths: incorrectPaths.length,
          omittedPaths: omittedPaths.length,
          pageWidth: result.scrollWidth,
        }),
      );
      expect(result.scrollWidth).toBe(width);
      if (mode === 'current') {
        expect(incorrectPaths).toEqual([]);
        expect(omittedPaths).toEqual([]);
      } else {
        expect(result.stubSources).toHaveLength(37);
        expect(withoutStub).toHaveLength(11);
      }
      await page.screenshot({
        path: testInfo.outputPath(`TIP12-${mode}-${width}.png`),
        fullPage: true,
      });
    });
  }
