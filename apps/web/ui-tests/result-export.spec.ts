import { readFile, writeFile } from 'node:fs/promises';
import { darwinBaseline, darwinScreenshot } from './darwinScreenshot';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mockEvent, PLAN_ID, ready } from './fixtures';
import { AxeBuilder } from '@axe-core/playwright';
import { chooseOption } from '../test-support/controls';

test(
  'actual downloaded results SVG keeps wide aliases inside the exported canvas',
  darwinBaseline,
  async ({ page }, testInfo) => {
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
      await darwinScreenshot(exported.locator('svg'), 'export-wide-alias.png');
    } finally {
      await exported.close();
    }
    expect(fixture.unexpected).toEqual([]);
  },
);

async function captureGraphicText(page: Page) {
  const drawn: string[] = [];
  await page.exposeFunction('recordResultsText', (text: string) => drawn.push(text));
  await page.addInitScript(() => {
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
      void (window as unknown as { recordResultsText: (text: string) => void }).recordResultsText(
        text,
      );
      fillText.call(this, text, x, y, maxWidth);
    };
  });
  return drawn;
}

async function previewBytes(image: Locator) {
  return Buffer.from(
    await image.evaluate(async (element: HTMLImageElement) =>
      Array.from(new Uint8Array(await (await fetch(element.src)).arrayBuffer())),
    ),
  );
}

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test(`${theme} ${width}px exports the same PNG it previews with a tied doubles field`, async ({
      page,
    }, testInfo) => {
      const organizer = theme === (width === 1440 ? 'dark' : 'light');
      const completedDivision = theme === 'light' && width === 1440;
      const scopeLabel = completedDivision ? 'Upper standings' : 'Upper championship';
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const drawn = await captureGraphicText(page);
      const fixture = await mockEvent(
        page,
        organizer ? { role: 'admin' } : completedDivision ? { role: 'player' } : {},
      );
      const places = [1, 2, 3, 3, 5, 6, 7, 8, 8, 10];
      const entrants = places.map((place, index) => ({
        entryKey: `pair-${index}`,
        name: `Pair ${index} (Public / Names)`,
        place,
        provisional: false,
        inFinalStage: true,
        playerId: null,
        wins: 2,
        losses: 1,
        poolWins: 0,
        poolLosses: 0,
        bracketWins: 2,
        bracketLosses: 1,
        graphic: {
          teamName: `Pair ${index}`,
          members: [
            {
              name: index === 0 ? '名前 / WIDE 🎮' : `Tag ${index}A`,
              character: index === 0 ? 'mario' : null,
            },
            { name: index === 0 ? 'Wide second public tag' : `Tag ${index}B`, character: null },
          ],
        },
      }));
      const brackets = [
        {
          tournamentId: '00000000-0000-4000-8000-000000000002',
          name: 'Championship',
          slug: 'championship',
          division: 'upper',
          stage: 'main',
          roleSource: 'plan',
          isComplete: true,
          players: entrants,
        },
        {
          tournamentId: '00000000-0000-4000-8000-000000000003',
          name: 'Consolation',
          slug: 'consolation',
          division: 'upper',
          stage: 'consolation',
          roleSource: 'plan',
          isComplete: completedDivision,
          players: entrants.map((entrant) => ({ ...entrant, provisional: !completedDivision })),
        },
      ];
      fixture.responses['public.eventOverview'] = {
        name: 'Tech In Place • Doubles Test',
        date: '2026-11-05T22:00:00.000Z',
        canonicalSlug: 'championship',
        competitionFormat: 'doubles',
        divisions: [{ division: 'upper', players: entrants, notice: null }],
        brackets,
        warnings: [],
      };
      const authorizationInputs: unknown[] = [];
      fixture.queryResponses.set('eventOps.canCustomizeResultGraphic', (input) => {
        authorizationInputs.push(input);
        return organizer;
      });
      await page.goto('/events/championship');
      if (!completedDivision) {
        await expect(
          page.getByRole('button', { name: 'Preview results PNG for Upper standings' }),
        ).toHaveCount(0);
        await expect(
          page.getByRole('button', { name: 'Preview results PNG for Upper consolation' }),
        ).toHaveCount(0);
      }
      const trigger = page.getByRole('button', { name: `Preview results PNG for ${scopeLabel}` });
      await ready(page);
      await page.screenshot({ path: testInfo.outputPath('event-route.png'), fullPage: true });
      await trigger.focus();
      await trigger.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Results graphic' });
      const image = dialog.getByRole('img', { name: new RegExp(scopeLabel) });
      await expect(image).toBeVisible();
      await expect
        .poll(() => drawn.includes('CONFIRMED FINISHES THROUGH 8TH / DOUBLES'))
        .toBe(true);
      expect(drawn).toContain('名前 / WIDE 🎮');
      expect(drawn).toContain('Wide second public tag');
      expect(drawn).toContain('Tag 8B');
      expect(drawn).not.toContain('Tag 9A');
      const lastRender = drawn.slice(drawn.lastIndexOf('NEMESIS / SMASH CLUB'));
      expect(lastRender.filter((label) => label === '08')).toHaveLength(2);
      expect(drawn).toContain('Mario');
      expect(drawn).toContain('6 NOV 2026');

      const placements = dialog.getByRole('button', { name: 'Placements in this graphic' });
      await placements.press('Enter');
      await expect(dialog.getByRole('listitem').filter({ hasText: 'Tag 8B' })).toContainText(
        '8 · Pair 8',
      );
      await expect(dialog.getByText(/名前 \/ WIDE 🎮 \(Mario\)/)).toBeVisible();
      await placements.press('Enter');
      const source = await image.getAttribute('src');
      if (organizer) {
        await expect
          .poll(() => authorizationInputs)
          .toEqual([{ tournamentIds: [brackets[0]!.tournamentId] }]);
        const customize = dialog.getByRole('button', { name: 'Choose character labels' });
        await customize.press('Enter');
        await chooseOption(dialog.getByRole('combobox', { name: 'Character label' }), {
          label: 'Luigi',
        });
        await expect.poll(() => image.getAttribute('src')).not.toEqual(source);
        await expect.poll(() => drawn.includes('Luigi')).toBe(true);
        expect(entrants[0]!.graphic.members[0]!.character).toBe('mario');
      } else {
        await expect
          .poll(() => authorizationInputs)
          .toEqual(
            completedDivision
              ? [{ tournamentIds: brackets.map(({ tournamentId }) => tournamentId) }]
              : [],
          );
        await expect(dialog.getByRole('button', { name: 'Choose character labels' })).toHaveCount(
          0,
        );
      }
      const preview = await previewBytes(image);
      const filename = testInfo.outputPath('confirmed-results.png');
      const downloaded = page.waitForEvent('download');
      await dialog.getByRole('button', { name: 'Download PNG ↓' }).click();
      const file = await downloaded;
      expect(file.suggestedFilename()).toBe(
        completedDivision
          ? 'nemesis-upper-standings-results.png'
          : 'nemesis-upper-championship-results.png',
      );
      await file.saveAs(filename);
      expect(await readFile(filename)).toEqual(preview);
      expect(preview.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(preview.readUInt32BE(16)).toBe(1920);
      expect(preview.readUInt32BE(20)).toBe(1080);
      await ready(page);
      expect(
        (await new AxeBuilder({ page }).include('.result-graphic-dialog').analyze()).violations,
      ).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath('event-preview.png'), fullPage: true });
      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();
      const legacy = page.waitForEvent('download');
      await page
        .locator('.result-graphic-actions')
        .filter({ has: trigger })
        .getByRole('button', { name: 'Download results graphic ↓' })
        .click();
      const svgFile = await legacy;
      const svgPath = testInfo.outputPath('tied-results.svg');
      await svgFile.saveAs(svgPath);
      const svg = await readFile(svgPath, 'utf8');
      expect(svg).toContain('Pair 7');
      expect(svg).toContain('Pair 8');
      expect(svg).not.toContain('Pair 9');
      expect(svg.match(/font-size="32">8<\/text>/g)).toHaveLength(2);
      expect(fixture.unexpected).toEqual([]);
    });

test('small confirmed pool PNG stays scoped and deterministic across reopening', async ({
  page,
}, testInfo) => {
  const fixture = await mockEvent(page);
  Object.assign(fixture.snapshot.plan, { structure: 'round_robin' });
  for (const placement of fixture.snapshot.placements) placement.division = 'upper';
  await page.goto(`/live/${PLAN_ID}`);
  const trigger = page.getByRole('button', { name: 'Preview results PNG for Open round robin' });
  const render = async () => {
    await trigger.click();
    const image = page.getByRole('img', { name: /Open round robin/ });
    await expect(image).toBeVisible();
    const bytes = await previewBytes(image);
    await page.keyboard.press('Escape');
    return bytes;
  };
  const first = await render();
  expect(await render()).toEqual(first);
  await writeFile(testInfo.outputPath('small-pool-results.png'), first);
  expect(fixture.unexpected).toEqual([]);
});

test('large tie stays complete within the mobile canvas limit', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await mockEvent(page);
  const drawn = await captureGraphicText(page);
  const players = Array.from({ length: 70 }, (_, index) => ({
    entryKey: `player-${index}`,
    name: `Wide public tag ${index + 1}`,
    place: index < 7 ? index + 1 : 8,
    provisional: false,
    playerId: null,
    wins: 1,
    losses: 1,
  }));
  fixture.responses['public.eventOverview'] = {
    name: 'Large tie',
    date: '2026-11-06',
    canonicalSlug: 'tie',
    competitionFormat: 'singles',
    divisions: [],
    brackets: [
      {
        tournamentId: '00000000-0000-4000-8000-000000000002',
        name: 'Tied finals',
        slug: 'tie',
        roleSource: 'unclassified',
        isComplete: true,
        players,
      },
    ],
    warnings: [],
  };
  await page.goto('/events/tie');
  await page.getByRole('button', { name: 'Preview results PNG for Tied finals' }).click();
  const image = page.getByRole('img', { name: /Tied finals/ });
  await expect(image).toBeVisible();
  expect(
    await image.evaluate(async (node: HTMLImageElement) => {
      await node.decode();
      return [node.naturalWidth, node.naturalHeight];
    }),
  ).toEqual([1619, 4096]);
  const lastRender = drawn.slice(drawn.lastIndexOf('NEMESIS / SMASH CLUB'));
  expect(lastRender.filter((label) => label === '08')).toHaveLength(63);
  expect(lastRender).toContain('Wide public tag 70');
  await writeFile(testInfo.outputPath('large-tie-results.png'), await previewBytes(image));

  await page.keyboard.press('Escape');
  const legacy = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download results graphic ↓' }).click();
  const svgPath = testInfo.outputPath('large-tie-results.svg');
  await (await legacy).saveAs(svgPath);
  const svg = await readFile(svgPath, 'utf8');
  expect(svg.match(/font-size="32">8<\/text>/g)).toHaveLength(63);
  const exportPage = await page.context().newPage();
  try {
    await exportPage.setContent(svg);
    const finalName = exportPage.getByText('Wide public tag 70', { exact: true });
    await finalName.scrollIntoViewIfNeeded();
    await expect(finalName).toBeInViewport();
    expect(
      await finalName.evaluate((node: SVGGraphicsElement) => {
        const box = node.getBBox();
        const { width, height } = node.ownerSVGElement!.viewBox.baseVal;
        return box.x + box.width <= width && box.y + box.height <= height;
      }),
    ).toBe(true);
  } finally {
    await exportPage.close();
  }
  expect(fixture.unexpected).toEqual([]);
});

test('signed-in readers can download the default PNG when organiser access fails', async ({
  page,
}) => {
  const fixture = await mockEvent(page, { role: 'player' });
  await page.route(/\/api\/trpc\/eventOps\.canCustomizeResultGraphic(?:\?|$)/, async (route) => {
    const response = {
      error: {
        message: 'Access lookup unavailable',
        code: -32603,
        data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
      },
    };
    const batched = new URL(route.request().url()).searchParams.has('batch');
    await route.fulfill({ json: batched ? [response] : response });
  });
  await page.goto(`/live/${PLAN_ID}`);
  const lookup = page.waitForResponse((response) =>
    response.url().includes('canCustomizeResultGraphic'),
  );
  await page.getByRole('button', { name: 'Preview results PNG for Lower · Pool A' }).click();
  await lookup;
  const dialog = page.getByRole('dialog', { name: 'Results graphic' });
  await expect(dialog.getByRole('img', { name: /Lower · Pool A/ })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Choose character labels' })).toHaveCount(0);
  const downloaded = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download PNG ↓' }).click();
  expect((await downloaded).suggestedFilename()).toBe('nemesis-lower-pool-a-results.png');
  expect(fixture.unexpected).toEqual([]);
});
