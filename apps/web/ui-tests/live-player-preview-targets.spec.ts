import { expect, test, type Locator } from '@playwright/test';
import { mockEvent, PLAN_ID, ready } from './fixtures';

const shortAlias = 'X';
const longAlias = 'AnUnbrokenTournamentAliasThatMustWrapInsideTheMatchCardAndPoolStandings';

async function expectSeparate(first: Locator, second: Locator) {
  const a = (await first.boundingBox())!;
  const b = (await second.boundingBox())!;
  const overlaps =
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  expect(overlaps).toBe(false);
}

async function expectTapTarget(trigger: Locator) {
  await trigger.evaluate((node) => node.scrollIntoView({ block: 'center', inline: 'nearest' }));
  const { width, height } = (await trigger.boundingBox())!;
  expect(width).toBeGreaterThanOrEqual(44);
  expect(height).toBeGreaterThanOrEqual(44);
  await expect
    .poll(() =>
      trigger.evaluate((node) => {
        const { left, right, top, bottom } = node.getBoundingClientRect();
        return [left + 4, right - 4]
          .flatMap((x) => [top + 4, bottom - 4].map((y) => document.elementFromPoint(x, y)))
          .every((hit) => node.contains(hit));
      }),
    )
    .toBe(true);
}

for (const width of [320, 390, 900])
  test.describe(`${width}px coarse pointer`, () => {
    test.use({ viewport: { width, height: 844 }, hasTouch: true, isMobile: true });

    for (const theme of ['dark', 'light'] as const)
      test(`keeps live player names reachable without overlapping controls in ${theme}`, async ({
        page,
      }, testInfo) => {
        await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
        const fixture = await mockEvent(page, { role: 'player', bracket: true });
        Object.assign(fixture.snapshot.plan, { competitionFormat: 'singles' });
        const playing = fixture.snapshot.matches.find((match) => match.status === 'playing')!;
        const semi = fixture.snapshot.matches.find((match) => match.id === 'fixture-semi-b')!;
        const recorded = fixture.snapshot.matches.find(
          (match) => match.stage === 'group' && match.status === 'complete',
        )!;
        const player1Id = playing.player1Id!;
        const player2Id = playing.player2Id!;
        const names = new Map([
          [player1Id, shortAlias],
          [player2Id, longAlias],
        ]);
        Object.assign(semi, { player1Id, player2Id });
        Object.assign(recorded, {
          player1Id,
          player2Id,
          winnerId: player1Id,
          division: playing.division,
          poolIndex: playing.poolIndex,
        });
        for (const match of fixture.snapshot.matches) {
          match.player1Name = names.get(match.player1Id ?? '') ?? match.player1Name;
          match.player2Name = names.get(match.player2Id ?? '') ?? match.player2Name;
        }
        fixture.responses['public.playerPreview'] = null;

        await page.goto(`/play/${PLAN_ID}?pool=${playing.division}%3A${playing.poolIndex}`);
        const match = page.locator(`[data-player-match-id="${playing.id}"]`);
        const pools = page.getByRole('region', { name: 'Pools', exact: true });
        const bracket = page.locator(`[data-match-id="${semi.id}"]`);
        const result = page.getByRole('region', { name: 'Results', exact: true });
        const surfaces = [
          ['match', match],
          ['pools', pools],
          ['bracket', bracket],
          ['result', result],
        ] as const;
        const button = (scope: Locator, name: string) =>
          scope.getByRole('button', { name: `Preview ${name}`, exact: true });
        await expect(button(match, shortAlias)).toBeVisible();
        await ready(page);
        expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);

        for (const [label, scope] of surfaces) {
          const first = button(scope, shortAlias);
          const second = button(scope, longAlias);
          await expectTapTarget(first);
          await expectTapTarget(second);
          await expectSeparate(first, second);
          await page.screenshot({ path: testInfo.outputPath(`${label}-preview-targets.png`) });
        }

        const wrappedName = await button(bracket, longAlias).evaluate((node) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          const bounds = node.getBoundingClientRect();
          const rects = Array.from(range.getClientRects());
          return {
            lines: rects.length,
            fits: rects.every((rect) => rect.left >= bounds.left && rect.right <= bounds.right),
          };
        });
        expect(wrappedName.lines).toBeGreaterThan(1);
        expect(wrappedName.fits).toBe(true);
        await expectSeparate(page.locator('[data-match-id="fixture-semi-a"]'), bracket);
        const score = match.getByRole('spinbutton').first();
        for (const name of [shortAlias, longAlias])
          await expectSeparate(button(match, name), score);
        await score.fill('2');
        const shortName = button(match, shortAlias);
        await shortName.tap({ position: { x: 39, y: 39 } });
        const dialog = page.getByRole('dialog', { name: shortAlias, exact: true });
        await expect(dialog).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
        await expect(shortName).toBeFocused();
        await expect(score).toHaveValue('2');
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
        expect(fixture.submissions).toEqual([]);
        expect(fixture.unexpected).toEqual([]);
      });
  });
