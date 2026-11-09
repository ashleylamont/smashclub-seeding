import { readFile, writeFile } from 'node:fs/promises';
import { darwinBaseline, darwinScreenshot } from './darwinScreenshot';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mockEvent, PLAN_ID, ready } from './fixtures';
import { AxeBuilder } from '@axe-core/playwright';
import { chooseOption } from '../test-support/controls';
import { FIGHTER_ART_CREDIT } from '../src/lib/resultGraphic';

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
    await page.getByRole('button', { name: 'Download SVG ↓' }).first().click();
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
  const base64 = await image.evaluate(async (element: HTMLImageElement) => {
    const blob = await (await fetch(element.src)).blob();
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener('load', () => resolve(String(reader.result).split(',')[1]!), {
        once: true,
      });
      reader.addEventListener('error', () => reject(reader.error), { once: true });
      reader.readAsDataURL(blob);
    });
  });
  return Buffer.from(base64, 'base64');
}

async function makeSyntheticPortrait(page: Page, base = '#0b8c86') {
  const data = await page.evaluate((background) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1536;
    canvas.height = 2048;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(6.4, 6.4);
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, 240, 320);
    ctx.fillStyle = '#69e3cf';
    ctx.beginPath();
    ctx.moveTo(0, 290);
    ctx.lineTo(240, 91);
    ctx.lineTo(240, 320);
    ctx.lineTo(0, 320);
    ctx.fill();
    ctx.fillStyle = '#142c45';
    ctx.beginPath();
    ctx.arc(120, 156, 64, 0, 2 * Math.PI);
    ctx.fill();
    ctx.fillRect(58, 196, 124, 115);
    ctx.fillStyle = '#ffbd70';
    ctx.fillRect(73, 142, 94, 31);
    return canvas.toDataURL('image/png').split(',')[1]!;
  }, base);
  return Buffer.from(data, 'base64');
}

async function pixels(image: Locator, points: [number, number][]) {
  return image.evaluate(async (element: HTMLImageElement, coordinates) => {
    await element.decode();
    const canvas = document.createElement('canvas');
    canvas.width = element.naturalWidth;
    canvas.height = element.naturalHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(element, 0, 0);
    return coordinates.map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data));
  }, points);
}

async function exerciseCharacterPack(page: Page, dialog: Locator, image: Locator, output: string) {
  const positions: [number, number][] = [
    [270, 300], // First member of the winning pair.
    [460, 300], // Teammate without a profile main.
    [805, 300], // Another player with the same main.
    [1195, 300], // Matching filename whose file cannot decode.
  ];
  const defaultPixels = await pixels(image, positions);
  const winnerArtPoints: [number, number][] = [
    [165, 630],
    [230, 685],
    [295, 740],
  ];
  const bundledWinner = await pixels(image, winnerArtPoints);
  const mario = {
    name: 'mario.png',
    mimeType: 'image/png',
    buffer: await makeSyntheticPortrait(page, '#8b324f'),
  };
  const luigi = {
    name: 'luigi.png',
    mimeType: 'image/png',
    buffer: await makeSyntheticPortrait(page, '#5f4fce'),
  };
  const corrupt = { mimeType: 'image/png', buffer: Buffer.from('damaged portrait') };
  const input = dialog.getByLabel('Character artwork files');
  const openChooser = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Load character artwork…' }).press('Enter');
  const chooser = await openChooser;
  expect(chooser.isMultiple()).toBe(true);
  await chooser.setFiles([mario, { ...mario, name: 'MARIO.PNG' }]);
  await expect(dialog.getByText('Choose only one artwork file for mario.')).toBeVisible();
  expect(await pixels(image, positions)).toEqual(defaultPixels);

  await input.setInputFiles([
    mario,
    luigi,
    { ...corrupt, name: 'link.png' },
    { ...corrupt, name: 'kirby.png' }, // No Kirby main in these placements.
  ]);
  await expect(dialog.getByText('4 images selected. Pack artwork used in 2 panels.')).toBeVisible();
  await expect(dialog.getByText('Could not open 1 image.', { exact: false })).toBeVisible();
  const marioPixel = [139, 50, 79, 255];
  expect(await pixels(image, positions)).toEqual([
    marioPixel,
    defaultPixels[1],
    marioPixel,
    defaultPixels[3],
  ]);
  await writeFile(output, await previewBytes(image));

  const label = dialog.getByRole('combobox', { name: 'Character label' });
  await chooseOption(label, { label: 'No character label' });
  await expect(dialog.getByText('4 images selected. Pack artwork used in 1 panel.')).toBeVisible();
  expect(await pixels(image, winnerArtPoints)).not.toEqual(bundledWinner);
  expect(await pixels(image, positions)).toEqual([
    defaultPixels[0],
    defaultPixels[1],
    marioPixel,
    defaultPixels[3],
  ]);
  await chooseOption(label, { label: 'Luigi' });
  await expect(dialog.getByText('4 images selected. Pack artwork used in 2 panels.')).toBeVisible();
  expect(await pixels(image, positions)).toEqual([
    [95, 79, 206, 255],
    defaultPixels[1],
    marioPixel,
    defaultPixels[3],
  ]);
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
              character: ['mario', 'mario', 'link', 'steve'][index] ?? null,
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
      let sessionUserId = 'fixture-organiser-a';
      if (organizer) {
        await page.route('**/api/auth/get-session', (route) =>
          route.fulfill({
            json: {
              user: { id: sessionUserId, name: 'Fixture organiser', emailVerified: true },
              session: {
                id: sessionUserId,
                userId: sessionUserId,
                expiresAt: '2027-01-01T00:00:00Z',
                token: 'local-fixture',
              },
            },
          }),
        );
      }
      const authorizationInputs: unknown[] = [];
      fixture.queryResponses.set('eventOps.canCustomizeResultGraphic', (input) => {
        authorizationInputs.push(input);
        return organizer;
      });
      const requestedPortraits: string[] = [];
      page.on('request', (request) => {
        const url = new URL(request.url());
        const filename = /\/portraits\/full\/([^/]+\.png)$/.exec(url.pathname)?.[1];
        if (filename && request.resourceType() === 'fetch') requestedPortraits.push(filename);
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
      expect(requestedPortraits).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath('event-route.png'), fullPage: true });
      await trigger.focus();
      await trigger.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Results graphic' });
      const image = dialog.getByRole('img', { name: new RegExp(scopeLabel) });
      await expect(image).toBeVisible();
      await expect(dialog.getByText(FIGHTER_ART_CREDIT, { exact: true })).toBeVisible();
      expect([...requestedPortraits].sort()).toEqual(['link.png', 'mario.png']);
      await expect
        .poll(() => drawn.includes('TOP 8 PLACES'))
        .toBe(true);
      expect(drawn).toContain('名前 / WIDE 🎮');
      expect(drawn).toContain('Wide second public tag');
      expect(drawn).toContain('Tag 8B');
      expect(drawn).not.toContain('Tag 9A');
      const lastRender = drawn.slice(drawn.lastIndexOf('NEMESIS / SMASH CLUB'));
      expect(lastRender.filter((label) => label === '8')).toHaveLength(2);
      expect(drawn).toContain('Mario');
      expect(drawn).toContain('Steve');
      expect(drawn).toContain(FIGHTER_ART_CREDIT);
      expect(drawn).toContain('6 NOV 2026');

      const placements = dialog.getByRole('button', { name: 'Placements in this graphic' });
      await placements.press('Enter');
      await expect(dialog.getByRole('listitem').filter({ hasText: 'Tag 8B' })).toContainText(
        '8 · Pair 8',
      );
      await expect(dialog.getByText(/名前 \/ WIDE 🎮 \(Mario\)/)).toBeVisible();
      await placements.press('Enter');
      const defaultArtwork = organizer ? await previewBytes(image) : null;
      if (organizer) {
        await expect
          .poll(() => authorizationInputs)
          .toEqual([{ tournamentIds: [brackets[0]!.tournamentId] }]);
        const customize = dialog.getByRole('button', { name: 'Customize graphic' });
        await customize.press('Enter');
        const apiWrites: string[] = [];
        page.on('request', (request) => {
          if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/'))
            apiWrites.push(request.url());
        });
        await exerciseCharacterPack(
          page,
          dialog,
          image,
          testInfo.outputPath('automatic-artwork.png'),
        );
        await expect.poll(() => drawn.includes('Luigi')).toBe(true);
        expect(entrants[0]!.graphic.members[0]!.character).toBe('mario');

        const fileInput = dialog.getByLabel('Portrait file');
        const portrait = {
          name: 'original-test-portrait.png',
          mimeType: 'image/png',
          buffer: await makeSyntheticPortrait(page),
        };
        const position: [number, number][] = [
          [270, 300],
          [460, 300],
        ];
        const beforeArt = await previewBytes(image);
        const fallbackPixels = await pixels(image, position);
        await fileInput.setInputFiles({
          name: 'not-an-image.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('not an image'),
        });
        await expect(dialog.getByText('Choose a PNG, JPEG or WebP portrait.')).toBeVisible();
        expect(await previewBytes(image)).toEqual(beforeArt);
        await fileInput.setInputFiles(portrait);
        await expect(dialog.getByRole('button', { name: 'Remove portrait' })).toBeEnabled();
        expect(await pixels(image, position)).toEqual([[11, 140, 134, 255], fallbackPixels[1]]);
        const portraitSrc = await image.getAttribute('src');
        await dialog.getByRole('button', { name: 'Remove portrait' }).press('Enter');
        await expect.poll(() => image.getAttribute('src')).not.toBe(portraitSrc);
        expect(await previewBytes(image)).toEqual(beforeArt);
        await fileInput.setInputFiles(portrait);
        await expect(dialog.getByRole('button', { name: 'Remove portrait' })).toBeEnabled();
        expect(await pixels(image, position)).toEqual([[11, 140, 134, 255], fallbackPixels[1]]);
        expect(apiWrites).toEqual([]);
      } else {
        await expect
          .poll(() => authorizationInputs)
          .toEqual(
            completedDivision
              ? [{ tournamentIds: brackets.map(({ tournamentId }) => tournamentId) }]
              : [],
          );
        await expect(dialog.getByRole('button', { name: 'Customize graphic' })).toHaveCount(0);
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
      expect(preview.readUInt32BE(20)).toBe(1332);
      await ready(page);
      expect(
        (await new AxeBuilder({ page }).include('.result-graphic-dialog').analyze()).violations,
      ).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath('event-preview.png'), fullPage: true });
      if (organizer) {
        const portraitSrc = await image.getAttribute('src');
        sessionUserId = 'fixture-organiser-b';
        await page.evaluate(() => {
          window.dispatchEvent(
            new StorageEvent('storage', {
              key: 'better-auth.message',
              newValue: JSON.stringify({ event: 'session', data: { trigger: 'updateUser' } }),
            }),
          );
        });
        await expect.poll(() => authorizationInputs.length).toBe(2);
        await expect.poll(() => image.getAttribute('src')).not.toBe(portraitSrc);
        expect(await previewBytes(image)).toEqual(defaultArtwork);
        await dialog.getByRole('button', { name: 'Customize graphic' }).press('Enter');
        await expect(dialog.getByRole('button', { name: 'Choose portrait…' })).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Remove portrait' })).toHaveCount(0);
        await expect(dialog.getByRole('button', { name: 'Load character artwork…' })).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Clear character artwork' })).toHaveCount(
          0,
        );
        await expect(dialog.getByRole('combobox', { name: 'Character label' })).toContainText(
          'Use profile main',
        );
      }
      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();
      const legacy = page.waitForEvent('download');
      await page
        .locator('.result-graphic-actions')
        .filter({ has: trigger })
        .getByRole('button', { name: 'Download SVG ↓' })
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
  ).toEqual([1539, 4096]);
  const lastRender = drawn.slice(drawn.lastIndexOf('NEMESIS / SMASH CLUB'));
  expect(lastRender.filter((label) => label === '8')).toHaveLength(63);
  expect(lastRender).toContain('Wide public tag 70');
  await writeFile(testInfo.outputPath('large-tie-results.png'), await previewBytes(image));

  await page.keyboard.press('Escape');
  const legacy = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download SVG ↓' }).click();
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

test('a live poll preserves the preview even when organiser access and portrait fetch fail', async ({
  page,
}, testInfo) => {
  const drawn = await captureGraphicText(page);
  const fixture = await mockEvent(page, { role: 'player' });
  const lowerPool = fixture.snapshot.placements.find(({ division }) => division === 'lower')!;
  const entrant = fixture.snapshot.entrants.find(({ id }) => id === lowerPool.playerId)!;
  Object.assign(entrant, {
    graphic: { teamName: null, members: [{ name: entrant.name, character: 'link' }] },
  });
  const linkPortrait = (url: URL) =>
    url.pathname.endsWith('/portraits/full/link.png') && !url.searchParams.has('import');
  const portraitFailure = page.waitForResponse(
    (response) => linkPortrait(new URL(response.url())) && response.status() === 404,
  );
  let portraitRequests = 0;
  await page.route(linkPortrait, (route) => {
    portraitRequests++;
    return route.fulfill({ status: 404 });
  });
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
  const trigger = page.getByRole('button', { name: 'Preview results PNG for Lower · Pool A' });
  await trigger.click();
  await Promise.all([lookup, portraitFailure]);
  const dialog = page.getByRole('dialog', { name: 'Results graphic' });
  const image = dialog.getByRole('img', { name: /Lower · Pool A/ });
  await expect(image).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Customize graphic' })).toHaveCount(0);
  await expect(dialog.getByText(FIGHTER_ART_CREDIT, { exact: true })).toHaveCount(0);
  await expect.poll(() => drawn.includes('Link')).toBe(true);
  expect(drawn).not.toContain(FIGHTER_ART_CREDIT);
  const imageUrl = await image.getAttribute('src');
  const preview = await previewBytes(image);
  const refreshedAlias = 'Refreshed public alias';
  entrant.name = refreshedAlias;
  Object.assign(entrant, {
    graphic: { teamName: null, members: [{ name: refreshedAlias, character: 'link' }] },
  });
  await expect(
    page.locator('.event-pool-ranking').getByText(refreshedAlias, { exact: false }),
  ).toBeAttached({ timeout: 10_000 });
  await expect(image).toHaveAttribute('src', imageUrl!);
  expect(portraitRequests).toBe(1);

  const downloaded = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download PNG ↓' }).click();
  const file = await downloaded;
  expect(file.suggestedFilename()).toBe('nemesis-lower-pool-a-results.png');
  const filename = testInfo.outputPath('live-poll-results.png');
  await file.saveAs(filename);
  expect(await readFile(filename)).toEqual(preview);

  await page.keyboard.press('Escape');
  await trigger.click();
  await dialog.getByRole('button', { name: 'Placements in this graphic' }).click();
  await expect(dialog.getByText(`${refreshedAlias} (Link)`, { exact: false })).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
});
