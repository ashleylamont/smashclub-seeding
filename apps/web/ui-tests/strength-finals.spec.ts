import { readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { trpc } from '../src/lib/trpc';
import { bracketCaptureOptions, mockEvent, PLAN_ID, ready } from './fixtures';

type Preview = Awaited<ReturnType<typeof trpc.eventOps.native.preview.query>>;
type StrengthPreview = Extract<Preview, { seedPolicy: 'pool_place_whr_v1' }>;

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test(`${theme} ${width}px previews combined seeds, changed byes and a waiting bracket`, async ({
      page,
    }, testInfo) => {
      const fixture = await mockEvent(page, { role: 'admin' });
      const [first, second, third] = fixture.snapshot.entrants;
      first!.name = 'Alex with a long tournament alias and a doubles partner';
      second!.name = 'Bea with another long tournament alias and partner';
      Object.assign(fixture.snapshot.plan, { bracketMode: 'native', structure: 'dual_division' });
      const waiting = {
        poolId: 'lower-pool',
        poolIndex: 0,
        division: 'lower',
        place: 2,
        status: 'pending',
      } as const;
      const preview: StrengthPreview = {
        seedPolicy: 'pool_place_whr_v1',
        existing: false,
        allowed: true,
        issues: [],
        replacing: false,
        resetAllowed: false,
        resetIssues: ['No finals exist.'],
        resetRevisionToken: 'reset-token',
        revisionToken: 'draw-token',
        poolOrders: [],
        waitingStages: [{ division: 'lower', stage: 'main', waiting: [waiting] }],
        brackets: [
          {
            id: 'upper-finals',
            division: 'upper',
            stage: 'main',
            entrantIds: [second!.id, third!.id, first!.id],
            alreadyDrawn: false,
            roundOne: [
              { player1Id: second!.id, player2Id: null },
              { player1Id: third!.id, player2Id: first!.id },
            ],
            strengthSeeding: {
              policy: 'pool_place_whr_v1',
              poolPlaceCost: 150,
              seeds: [
                {
                  playerId: second!.id,
                  place: 2,
                  strength: 1900,
                  strengthSource: 'frozen',
                  combinedScore: 1750,
                  provisionalSeed: 1,
                  bracketSeed: 1,
                  poolPlaceSeed: 3,
                },
                {
                  playerId: third!.id,
                  place: 1,
                  strength: 1490,
                  strengthSource: 'frozen',
                  combinedScore: 1490,
                  provisionalSeed: 2,
                  bracketSeed: 2,
                  poolPlaceSeed: 2,
                },
                {
                  playerId: first!.id,
                  place: 1,
                  strength: 1083.1,
                  strengthSource: 'prior',
                  combinedScore: 1083.1,
                  provisionalSeed: 3,
                  bracketSeed: 3,
                  poolPlaceSeed: 1,
                },
              ],
              comparison: {
                poolPlaces: { byes: [first!.id], rematchesByRound: [0, 1] },
                combined: { byes: [second!.id], rematchesByRound: [0, 1] },
              },
            },
          },
        ],
      };
      fixture.responses['eventOps.native.preview'] = preview;
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      await page.goto(`/operate/${PLAN_ID}?view=draw`);
      await page.getByRole('button', { name: 'Preview finals', exact: true }).click();
      await expect(page.getByText(/lower championship is waiting for/)).toContainText('place 2');
      await expect(
        page.getByRole('heading', { name: 'upper championship · 3 entrants' }),
      ).toBeVisible();
      const compare = page.getByRole('button', { name: 'Compare seeding and byes' });
      await compare.press('Enter');
      const region = page.getByRole('region', { name: 'Finals seeding comparison' });
      await expect(region.getByRole('row').filter({ hasText: first!.name })).toContainText(
        '(prior)',
      );
      await expect(region.getByRole('row').filter({ hasText: second!.name })).toContainText(
        '1750.0',
      );
      await expect(page.getByText(`Pool-place byes · ${first!.name}`)).toBeVisible();
      await expect(page.getByText(`Combined byes · ${second!.name}`)).toBeVisible();
      await ready(page);
      await region.focus();
      await expect(region).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(
        (
          await new AxeBuilder({ page })
            .include('.ops-page')
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath(`combined-finals-${theme}-${width}.png`),
        fullPage: true,
        style: readFileSync(bracketCaptureOptions.stylePath, 'utf8'),
      });
      if (width === 390) {
        await region.press('ArrowRight');
        await expect.poll(() => region.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
      }
      await page.getByRole('button', { name: 'Create ready finals' }).press('Enter');
      const confirmation = page.getByRole('alertdialog');
      await expect(confirmation).toContainText('seed order will be fixed');
      await page.keyboard.press('Escape');
      await expect(confirmation).not.toBeVisible();
      expect(fixture.unexpected).toEqual([]);
    });
