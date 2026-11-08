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
      const matchTemplate = {
        ...fixture.snapshot.matches[0]!,
        division: 'upper' as const,
        stage: 'main' as const,
        called: false,
        callLocation: null,
        poolIndex: null,
        nativeBracketId: 'upper-finals',
        syncState: 'local' as const,
        sourceSetId: null,
        eventPlanId: PLAN_ID,
        resultUpdatedAt: null,
        score1: null,
        score2: null,
        stationId: null,
      };
      const preview: StrengthPreview = {
        seedPolicy: 'pool_place_whr_v1',
        existing: false,
        allowed: true,
        issues: [],
        replacing: false,
        resetAllowed: false,
        resetIssues: ['No finals exist.'],
        resetBracketIds: [],
        resetCallMatchIds: [],
        divisionResets: [],
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
            previewMatches: [
              {
                ...matchTemplate,
                id: 'bye',
                label: 'Semi-final 1',
                nativeRound: 1,
                nativeSlot: 0,
                player1Id: second!.id,
                player2Id: null,
                outcome: 'bye',
                status: 'complete',
                winnerId: second!.id,
              },
              {
                ...matchTemplate,
                id: 'played-semi',
                label: 'Semi-final 2',
                nativeRound: 1,
                nativeSlot: 1,
                player1Id: third!.id,
                player2Id: first!.id,
                outcome: null,
                status: 'ready',
                winnerId: null,
              },
              {
                ...matchTemplate,
                id: 'final',
                label: 'Final',
                nativeRound: 2,
                nativeSlot: 0,
                parent1MatchId: 'bye',
                parent2MatchId: 'played-semi',
                player1Id: null,
                player2Id: null,
                outcome: null,
                status: 'blocked',
                winnerId: null,
              },
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
      const draw = page.getByRole('region', { name: 'upper championship bracket preview' });
      await expect(draw.locator('.event-bracket-match')).toHaveCount(3);
      await expect(draw.getByRole('article', { name: 'Semi-final 1: Bye' })).toContainText(
        second!.name,
      );
      await expect(draw.getByRole('article', { name: 'Final: Waiting for feeders' })).toContainText(
        'Winner of Semi-final 2',
      );
      await expect(draw.locator('path[data-feed-to="final"]')).toHaveCount(2);
      await expect(
        page.getByRole('region', { name: 'lower championship bracket preview' }),
      ).toHaveCount(0);
      if (width === 390) {
        await draw.press('ArrowRight');
        await expect.poll(() => draw.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
        await draw.evaluate((node) => {
          node.scrollLeft = 0;
        });
      }
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
      if (width === 1440 && theme === 'light') {
        await page.locator('.native-finals-controls').screenshot({
          path: testInfo.outputPath('to-precommit-bracket-preview.png'),
          style: readFileSync(bracketCaptureOptions.stylePath, 'utf8'),
        });
      }
      if (width === 390) {
        await region.press('ArrowRight');
        await expect.poll(() => region.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
      }
      await page.getByRole('button', { name: 'Create ready finals' }).press('Enter');
      const confirmation = page.getByRole('alertdialog');
      await expect(confirmation).toContainText('seed order will be fixed');
      await page.keyboard.press('Escape');
      await expect(confirmation).not.toBeVisible();
      const requests: Record<string, unknown>[] = [];
      await page.route('**/api/trpc/eventOps.native.generate*', async (route) => {
        const url = new URL(route.request().url());
        const body = JSON.parse(route.request().postData() ?? '{}');
        requests.push(url.searchParams.get('batch') ? body[0] : body);
        if (requests.length === 1) {
          await route.abort('failed');
          return;
        }
        const result = { result: { data: { created: 1 } } };
        await route.fulfill({ json: url.searchParams.get('batch') ? [result] : result });
      });
      for (let attempt = 0; attempt < 2; attempt++) {
        await page.getByRole('button', { name: 'Create ready finals' }).click();
        await confirmation.getByRole('button', { name: 'Confirm', exact: true }).click();
        if (attempt === 0) {
          await expect(page.getByRole('alert')).toBeVisible();
          await expect(region).toBeVisible();
          await page.screenshot({
            path: testInfo.outputPath(`combined-finals-retry-${theme}-${width}.png`),
            fullPage: true,
            style: readFileSync(bracketCaptureOptions.stylePath, 'utf8'),
          });
        } else {
          await expect(page.getByRole('status')).toContainText('Ready finals created');
        }
      }
      expect(requests[0]?.requestId).toEqual(expect.any(String));
      expect(requests[1]).toEqual(requests[0]);
      await page.getByRole('button', { name: 'Preview finals', exact: true }).click();
      await page.getByRole('button', { name: 'Create ready finals' }).click();
      await confirmation.getByRole('button', { name: 'Confirm', exact: true }).click();
      await expect(page.getByRole('status')).toContainText('Ready finals created');
      expect(requests).toHaveLength(3);
      expect(requests[2]?.requestId).not.toBe(requests[0]?.requestId);
      expect(requests[2]?.revisionToken).toBe(requests[0]?.revisionToken);
      expect(fixture.unexpected).toEqual([]);
    });
