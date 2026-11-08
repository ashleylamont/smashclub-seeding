import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { LiveMatch } from '../src/lib/eventDisplay';
import { fixtures, TEAM_ALIAS } from './local-renderer-fixtures';

const bundle = `${process.env.NEMESIS_RENDERER_PROBE_DIR}/package/dist`;
const lanes = ['winners', 'losers', 'finals'];
const lane = (match: LiveMatch) =>
  match.bracketLane === 'final' || match.bracketLane === 'reset'
    ? 'finals'
    : (match.bracketLane ?? 'winners');
function round(match: LiveMatch) {
  if (match.bracketLane === 'final') return 1;
  if (match.bracketLane === 'reset') return 2;
  return match.bracketRound ?? match.nativeRound ?? 1;
}
const status = new Map([
  ['blocked', 1],
  ['ready', 2],
  ['playing', 3],
  ['complete', 4],
]);

function viewerModel(fields: ReturnType<typeof fixtures>) {
  const stages = fields.map(({ name, index, size, double }) => ({
    id: index,
    tournament_id: 1,
    name,
    number: index + 1,
    type: double ? 'double_elimination' : 'single_elimination',
    settings: { size, ...(double ? { grandFinal: 'double' } : {}) },
  }));
  const participants = fields.flatMap(({ size, index }) =>
    Array.from({ length: size }, (_, i) => ({
      id: `${index}:entrant-${i}`,
      tournament_id: 1,
      name: i === 0 ? TEAM_ALIAS : `Entrant ${i + 1}`,
    })),
  );
  const matches = fields.flatMap(({ graph, index }) => {
    const sources = new Map(graph.map((match) => [match.id, match]));
    const side = (match: LiveMatch, n: 1 | 2) => {
      const entrant = match[`player${n}Id`];
      const source = sources.get(match[`parent${n}MatchId`] ?? '');
      if (!entrant && !source && match.outcome === 'bye') return null;
      const score = match[`score${n}`];
      return {
        id: entrant ? `${index}:${entrant}` : null,
        ...(source ? { position: (source.nativeSlot ?? 0) + 1 } : {}),
        ...(score === null ? {} : { score }),
        ...(entrant && match.winnerId
          ? { result: entrant === match.winnerId ? 'win' : 'loss' }
          : {}),
      };
    };
    return graph
      .toSorted((a, b) => lanes.indexOf(lane(a)) - lanes.indexOf(lane(b)) || round(a) - round(b))
      .map((match) => ({
        id: `${index}:${match.id}`,
        stage_id: index,
        group_id: index * 3 + lanes.indexOf(lane(match)) + 1,
        round_id: `${index}:${lane(match)}:${round(match)}`,
        number: (match.nativeSlot ?? 0) + 1,
        child_count: 0,
        status: status.get(match.status) ?? 0,
        opponent1: side(match, 1),
        opponent2: side(match, 2),
      }));
  });
  return { stages, matches, participants, matchGames: [] };
}

type Model = ReturnType<typeof viewerModel>;

async function render(page: Page, model: Model) {
  await page.evaluate(async (data) => {
    const { bracketsViewer } = window as unknown as {
      bracketsViewer: { render: (input: Model, config: unknown) => Promise<void> };
    };
    await bracketsViewer.render(data, {
      selector: '#brackets',
      clear: true,
      showSlotsOrigin: true,
      showLowerBracketSlotsOrigin: true,
      customRoundName: ({ roundNumber, finalType }: { roundNumber: number; finalType?: string }) =>
        finalType && roundNumber === 2 ? 'Reset final · If needed' : undefined,
    });
  }, model);
}

async function axeViolations(page: Page) {
  const report = await new AxeBuilder({ page })
    .include('#brackets')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  return report.violations.map(({ id }) => id);
}

for (const shape of ['se', 'de', 'mixed'] as const) {
  for (const width of [390, 1440]) {
    test(`candidate ${shape} ${width}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.route('**/*', (route) => {
        if (new URL(route.request().url()).pathname !== '/renderer-spike') return route.abort();
        return route.fulfill({
          contentType: 'text/html',
          body: '<html lang="en"><head><title>Renderer comparison</title><style>body{margin:0}</style></head><body><main><h1>Renderer comparison</h1><div id="brackets" class="brackets-viewer"></div></main></body></html>',
        });
      });
      await page.goto('/renderer-spike');
      await page.addStyleTag({ path: `${bundle}/brackets-viewer.min.css` });
      await page.addScriptTag({ path: `${bundle}/brackets-viewer.min.js` });

      const fields = fixtures(shape);
      const model = viewerModel(fields);
      await render(page, model);
      const root = page.locator('#brackets');
      const card = (match: LiveMatch, stage = 0) =>
        root.locator(`[data-match-id="${stage}:${match.id}"]`);
      await expect(root.locator('.match[data-match-id]')).toHaveCount(
        model.matches.length - (shape === 'de' ? 1 : 0),
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      for (const { name, index, played } of fields) {
        await expect(root.getByText(name, { exact: true })).toBeVisible();
        await expect(card(played, index).locator('.participant.loss .result')).toHaveText('1');
        await expect(card(played, index).locator('.participant.win .result')).toHaveText('2');
      }
      const [{ graph, noContest }] = fields;
      const pending = graph.find(
        (match) => match.status === 'blocked' && lane(match) === 'winners',
      )!;
      await expect(card(pending).locator('.name')).toHaveText(['', '']);
      if (shape !== 'mixed')
        await expect(root.getByText('BYE', { exact: true }).first()).toBeVisible();
      const alias = root.locator('.name').filter({ hasText: TEAM_ALIAS }).first();
      expect(await alias.evaluate((name) => name.scrollWidth - name.clientWidth)).toBeGreaterThan(
        0,
      );
      if (width === 390) expect(await axeViolations(page)).toContain('scrollable-region-focusable');
      await page.screenshot({ path: testInfo.outputPath('default.png'), fullPage: true });

      await root.evaluate((element) => {
        element.setAttribute('tabindex', '0');
        element.setAttribute('role', 'region');
        element.setAttribute('aria-label', 'Tournament brackets');
      });
      await page.addStyleTag({
        content: `
        .brackets-viewer { --label-color: #555; --hint-color: #555; }
        .brackets-viewer .participant .name { white-space: normal; overflow-wrap: anywhere; }
      `,
      });
      expect(await alias.evaluate((name) => name.scrollWidth - name.clientWidth)).toBe(0);
      await page.keyboard.press('Tab');
      await expect(root).toBeFocused();
      if (width === 390) {
        await page.keyboard.press('ArrowRight');
        await expect.poll(() => root.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
        await root.evaluate((element) => (element.scrollLeft = 0));
      }
      const violations = await axeViolations(page);
      expect(violations).not.toContain('scrollable-region-focusable');
      if (shape === 'de') expect(violations).toContain('color-contrast');
      await page.screenshot({ path: testInfo.outputPath('host-styled.png'), fullPage: true });

      if (shape === 'de') {
        const final = graph.find((match) => match.bracketLane === 'final')!;
        const crossFeed = graph.find((match) => lane(match) === 'losers' && round(match) === 2)!;
        expect(final.parent1MatchId).toContain(':winners:');
        expect(crossFeed.parent1Outcome).toBe('winner');
        await expect(card(final).locator('.name')).toHaveText([
          'Winner of LB Final',
          'Winner of LB Final',
        ]);
        await expect(card(crossFeed).locator('.name')).toHaveText([
          'Loser of WB Semi 1',
          'Loser of WB Semi 2',
        ]);
        await expect(card(noContest!).locator('.name')).toHaveText(['', '']);
        const reset = graph.find((match) => match.bracketLane === 'reset')!;
        await expect(card(reset)).toHaveCount(0);
        const adaptedFinal = model.matches.find(({ id }) => id === `0:${final.id}`)!;
        for (const result of [undefined, 'win', 'loss']) {
          adaptedFinal.opponent1 = { id: '0:entrant-0', ...(result ? { result } : {}) };
          await render(page, model);
          await expect(card(reset)).toHaveCount(result === 'win' ? 0 : 1);
          if (result !== 'win')
            await expect(root.getByText('Reset final · If needed')).toBeVisible();
        }
        await page.screenshot({ path: testInfo.outputPath('supported-reset.png'), fullPage: true });
      }
    });
  }
}
