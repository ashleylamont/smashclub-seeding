import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { LiveMatch } from '../src/lib/eventDisplay';
import { fixtures, TEAM_ALIAS } from './local-renderer-fixtures';
import type { Shape } from './local-renderer-fixtures';

type Mode = 'default' | 'labels' | 'without-reset' | 'pan-zoom' | 'light' | 'dark';
const bracketSelector = '#brackets';

async function render(page: Page, shape: Shape, mode: Mode) {
  await page.evaluate(
    ({ shape, mode }) => {
      const { probeRender } = window as unknown as {
        probeRender: (
          shape: Shape,
          labels: boolean,
          omit: boolean,
          pan: boolean,
          theme?: 'light' | 'dark',
        ) => void;
      };
      const theme = mode === 'light' || mode === 'dark' ? mode : undefined;
      document.body.style.background = theme === 'dark' ? '#101417' : '#fff';
      document.body.style.color = theme === 'dark' ? '#fff' : '#101417';
      probeRender(
        shape,
        mode !== 'default' && mode !== 'pan-zoom',
        mode === 'without-reset',
        mode === 'pan-zoom',
        theme,
      );
    },
    { shape, mode },
  );
}

async function axeViolations(page: Page) {
  const result = await new AxeBuilder({ page })
    .include(bracketSelector)
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  return result.violations.map(({ id }) => id);
}

async function byeClipping(card: Locator) {
  return card.evaluate((element) => {
    const box = element.closest('foreignObject')!.getBoundingClientRect();
    const label = [...element.querySelectorAll('*')].find(
      (node) => !node.childElementCount && node.textContent === 'Bye',
    )!;
    const range = document.createRange();
    range.selectNodeContents(label);
    return range.getBoundingClientRect().bottom - box.bottom;
  });
}

async function connectorPairs(root: Locator) {
  return root.evaluate((element) => {
    const bounds = [...element.querySelectorAll('foreignObject')].map((card) => ({
      id: card.querySelector<HTMLElement>('[data-match-id]')!.dataset.matchId,
      rect: card.getBoundingClientRect(),
    }));
    return [...element.querySelectorAll<SVGPathElement>('svg path')].map((path) => {
      const matrix = path.getScreenCTM()!;
      const destination = path.getPointAtLength(0).matrixTransform(matrix);
      const source = path.getPointAtLength(path.getTotalLength()).matrixTransform(matrix);
      const findCard = (point: DOMPoint, edge: 'left' | 'right') =>
        bounds.find(
          ({ rect }) =>
            Math.abs(rect[edge] - point.x) < 2 && point.y >= rect.top && point.y <= rect.bottom,
        )?.id;
      return `${findCard(source, 'right')}>${findCard(destination, 'left')}`;
    });
  });
}

for (const shape of ['se', 'de', 'mixed'] as const) {
  for (const width of [390, 1440]) {
    test(`React candidate ${shape} ${width}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.route('**/*', (route) => route.abort());
      await page.setContent(`<!doctype html><html lang="en"><head><title>React renderer comparison</title>
        <style>body{margin:0;font:16px sans-serif} #brackets{width:100%;overflow-x:auto} section{margin-bottom:16px}</style>
        </head><body><main><h1 tabindex="-1">Renderer comparison</h1><div id="brackets"></div></main></body></html>`);
      await page.addScriptTag({
        path: `${process.env.NEMESIS_RENDERER_PROBE_DIR}/react-viewer.js`,
      });
      await render(page, shape, 'default');
      const root = page.locator(bracketSelector);
      const fields = fixtures(shape);
      const stage = (index: number) => root.locator(`[data-stage="${index}"]`);
      const card = (match: LiveMatch, index = 0) =>
        stage(index).locator(`[data-match-id="${match.id}"]`);
      for (const { name, graph, played, index } of fields) {
        await expect(stage(index).getByRole('heading', { name })).toBeVisible();
        await expect(stage(index).locator('[data-match-id]')).toHaveCount(graph.length);
        await expect(card(played, index).getByText('1', { exact: true })).toBeVisible();
        await expect(card(played, index).getByText('2', { exact: true })).toBeVisible();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      if (shape !== 'de') return;

      const [{ graph, noContest }] = fields;
      const final = graph.find((match) => match.bracketLane === 'final')!;
      const reset = graph.find((match) => match.bracketLane === 'reset')!;
      const bye = graph.find((match) => match.outcome === 'bye')!;
      const crossFeed = graph.find(
        (match) => match.bracketLane === 'losers' && match.bracketRound === 2,
      )!;
      await expect(card(final)).toHaveText('Grand final');
      await expect(card(reset)).toHaveText('Reset final · If needed');
      await expect(card(bye)).not.toContainText('Bye');
      await render(page, shape, 'labels');
      await expect(card(final)).toContainText('Winner of winners 3 · M1');
      await expect(card(final)).toContainText('Winner of losers 4 · M1');
      await expect(card(crossFeed)).toContainText('Winner of losers 1 · M1');
      await expect(card(crossFeed)).toContainText('Loser of winners 2 · M2');
      await expect(card(noContest!).getByText('No entrant', { exact: true })).toHaveCount(2);
      await expect(card(bye)).toContainText(TEAM_ALIAS);
      expect(await byeClipping(card(bye))).toBeGreaterThan(0);
      await page.screenshot({ path: testInfo.outputPath('default-clipping.png'), fullPage: true });

      await render(page, shape, 'without-reset');
      await expect(card(reset)).toHaveCount(0);
      await expect(root.locator('[data-match-id]')).toHaveCount(14);
      await render(page, shape, 'pan-zoom');
      await expect(root.locator('[data-match-id]')).toHaveCount(30);
      expect(await axeViolations(page)).toEqual(
        expect.arrayContaining(['button-name', 'color-contrast']),
      );
      await page.screenshot({ path: testInfo.outputPath('pan-zoom.png'), fullPage: true });

      await root.evaluate((element) => {
        element.setAttribute('tabindex', '0');
        element.setAttribute('role', 'region');
        element.setAttribute('aria-label', 'Tournament brackets');
      });
      const expectedWinnerPairs = graph.flatMap((match) =>
        ([1, 2] as const).flatMap((side) => {
          const source = match[`parent${side}MatchId`];
          return source && match[`parent${side}Outcome`] === 'winner'
            ? [`${source}>${match.id}`]
            : [];
        }),
      );
      for (const theme of ['light', 'dark'] as const) {
        await render(page, shape, theme);
        await expect(root.locator('[data-match-id]')).toHaveCount(15);
        await expect.poll(() => byeClipping(card(bye))).toBeLessThanOrEqual(0);
        expect((await connectorPairs(root)).toSorted()).toEqual(expectedWinnerPairs.toSorted());
        expect(await axeViolations(page)).toEqual([]);
        await root.evaluate((element) => {
          element.scrollLeft = 0;
        });
        await page.getByRole('heading', { name: 'Renderer comparison' }).focus();
        await page.keyboard.press('Tab');
        await expect(root).toBeFocused();
        await page.screenshot({
          path: testInfo.outputPath(`adapted-${theme}-start.png`),
          fullPage: true,
        });
        await page.keyboard.press('ArrowRight');
        await expect.poll(() => root.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
        await root.evaluate((element) => {
          element.scrollLeft = element.scrollWidth;
        });
        await page.screenshot({
          path: testInfo.outputPath(`adapted-${theme}.png`),
          fullPage: true,
        });
      }
    });
  }
}
