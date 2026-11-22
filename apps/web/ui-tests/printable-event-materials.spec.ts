import { expect, test, type Locator, type Page } from '@playwright/test';
import jsQR from 'jsqr';
import { darwinBaseline, darwinScreenshot } from './darwinScreenshot';
import { mockEvent, PLAN_ID, ready } from './fixtures';

const PRINT_ORIGIN = 'http://127.0.0.1:3411';
// A4 portrait minus the stylesheet's 12 mm margins, at 96 CSS pixels per inch.
const A4_CONTENT = { width: 703, height: 1032 };

test.describe('A4 event printouts', () => {
  test.beforeEach(async ({ page, baseURL }) => {
    // Keep the production QR payload and the printed URL stable when UI_PORT changes.
    if (baseURL && baseURL !== PRINT_ORIGIN)
      await page.route(`${PRINT_ORIGIN}/**`, (route) =>
        route.continue({ url: route.request().url().replace(PRINT_ORIGIN, baseURL) }),
      );
  });

  test(
    'published pool floor sheet keeps pairings and the public QR readable',
    darwinBaseline,
    async ({ page }) => {
      const { overview, unexpected } = await mockEvent(page, { role: 'admin' });
      const active = overview.matches.find(
        (match) =>
          match.division === 'upper' && match.poolIndex === 0 && match.status === 'playing',
      )!;
      const alias = 'Alexandria with a long tournament alias from Western Sydney';
      for (const match of overview.matches) {
        if (match.player1Id === active.player1Id) match.player1Name = alias;
        if (match.player2Id === active.player1Id) match.player2Name = alias;
      }
      const entrant = overview.entrants.find((item) => item.id === active.player1Id)!;
      entrant.name = alias;
      Object.assign(active, { score1: 1, score2: 0, liveScore1: 1, liveScore2: 0, started: true });
      const rounds = overview.poolRounds.find((pool) => pool.poolKey === 'upper:0')!.rounds;
      // The long alias in the base fixture replaces the original resting entrant.
      rounds.find((round) => round.round === 3)!.restingPlayerIds = [active.player1Id!];
      Object.assign(overview, {
        poolSchedules: [
          {
            division: 'upper',
            poolIndex: 0,
            active: true,
            stationIds: overview.stations.map((station) => station.id),
            selfRun: true,
            autoAcceptScores: true,
          },
        ],
      });

      await page.goto(`${PRINT_ORIGIN}/admin/event-operations?plan=${PLAN_ID}`);
      await page.getByRole('button', { name: 'Pool queues and stations', exact: true }).click();
      await page.getByRole('button', { name: 'Print pool sheets', exact: true }).click();
      const preview = page.getByRole('dialog', { name: 'Print pool sheets', exact: true });
      await expect(preview.getByRole('button', { name: 'Print selected pools' })).toBeEnabled();
      for (const name of ['Upper Pool B', 'Lower Pool A', 'Lower Pool B'])
        await preview.getByRole('checkbox', { name, exact: true }).uncheck();

      const sheet = preview.getByRole('article');
      await expect(sheet).toHaveCount(1);
      await expect(sheet.getByRole('heading', { name: 'Upper Pool A', exact: true })).toBeVisible();
      await expect(sheet).toContainText('Setup 2 + Stage');
      await expect(sheet.getByRole('table')).toContainText(alias);
      await expect(sheet.getByRole('table')).toContainText('Playing · 1 – 0');
      await expect(sheet.locator('tbody tr')).toHaveCount(15);
      const url = `${PRINT_ORIGIN}/live/${PLAN_ID}?pool=upper%3A0`;
      await expect(sheet.getByRole('link', { name: url, exact: true })).toHaveAttribute(
        'href',
        url,
      );
      expect(
        await decodeQr(sheet.getByRole('img', { name: 'QR code for Upper Pool A live board' })),
      ).toBe(url);

      await emulateA4Print(page);
      await expect(preview.getByRole('button', { name: 'Print selected pools' })).toBeHidden();
      await expectPaperInk(sheet, 3);
      expect(
        await sheet
          .locator('tr')
          .evaluateAll((rows) => rows.every((row) => row.scrollWidth <= row.clientWidth)),
      ).toBe(true);
      const bounds = (await sheet.boundingBox())!;
      expect(bounds.height).toBeLessThanOrEqual(A4_CONTENT.height);
      expect(bounds.width).toBeLessThanOrEqual(A4_CONTENT.width);
      expect(unexpected).toEqual([]);
      await darwinScreenshot(sheet, 'published-pool-floor-sheet-a4.png');
    },
  );

  test(
    'station sign keeps its name and permanent guest QR readable',
    darwinBaseline,
    async ({ page }) => {
      const { overview, responses, unexpected } = await mockEvent(page, { role: 'admin' });
      const station = overview.stations[0]!;
      station.name = 'North Hall · Main Stage';
      const token = 'persistent.synthetic-station-sign';
      responses['eventOps.guests.settings'] = {
        enabled: true,
        showOnOverlay: false,
        rotateInvitations: false,
      };
      responses['eventOps.guests.invitation'] = { token, expiresAt: null };

      await page.goto(`${PRINT_ORIGIN}/admin/event-operations?plan=${PLAN_ID}&view=settings`);
      await page.getByRole('button', { name: 'Print station signs', exact: true }).click();
      const preview = page.getByRole('dialog', { name: 'Print station signs', exact: true });
      await expect(preview.getByRole('button', { name: 'Print selected signs' })).toBeEnabled();
      await preview.getByRole('checkbox', { name: 'Setup 2', exact: true }).uncheck();

      const sign = preview.getByRole('article');
      await expect(sign).toHaveCount(1);
      await expect(sign.getByRole('heading', { name: station.name, exact: true })).toBeVisible();
      const qr = sign.getByRole('img', { name: `Guest score reporting QR for ${station.name}` });
      expect(await decodeQr(qr)).toBe(
        `${PRINT_ORIGIN}/play/${PLAN_ID}?station=${station.id}#token=${token}`,
      );

      await emulateA4Print(page);
      await expect(preview.getByRole('button', { name: 'Print selected signs' })).toBeHidden();
      await expectPaperInk(sign, 2);
      const bounds = (await sign.boundingBox())!;
      expect(bounds.height).toBeLessThanOrEqual(A4_CONTENT.height);
      expect(bounds.width).toBeLessThanOrEqual(A4_CONTENT.width);
      expect(unexpected).toEqual([]);
      await darwinScreenshot(sign, 'guest-station-sign-a4.png');
    },
  );
});

async function emulateA4Print(page: Page) {
  await page.setViewportSize(A4_CONTENT);
  await page.emulateMedia({ media: 'print' });
  await ready(page);
  await expect(page.locator('#root')).toBeHidden();
  expect(await page.evaluate(() => getComputedStyle(document.body, '::before').display)).toBe(
    'none',
  );
}

async function expectPaperInk(paper: Locator, headingCount: number) {
  await expect(paper).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  const headingColors = await paper
    .getByRole('heading')
    .evaluateAll((headings) => headings.map((heading) => getComputedStyle(heading).color));
  expect(headingColors).toEqual(Array<string>(headingCount).fill('rgb(17, 17, 17)'));
}

async function decodeQr(image: Locator) {
  const pixels = await image.evaluate(async (node: HTMLImageElement) => {
    await node.decode();
    const canvas = document.createElement('canvas');
    canvas.width = node.naturalWidth;
    canvas.height = node.naturalHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(node, 0, 0);
    return {
      bytes: [...context.getImageData(0, 0, canvas.width, canvas.height).data],
      width: canvas.width,
      height: canvas.height,
    };
  });
  return jsQR(Uint8ClampedArray.from(pixels.bytes), pixels.width, pixels.height)?.data;
}
