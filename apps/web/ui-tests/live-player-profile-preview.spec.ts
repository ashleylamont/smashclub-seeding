import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mockEvent, PLAN_ID, PLAYER_NAME, ready } from './fixtures';

for (const width of [390, 1440])
  test.describe(`${width}px live player previews`, () => {
    test.use({ hasTouch: width === 390 });

    for (const theme of ['dark', 'light'] as const)
      test(`opens singles profiles without losing a live score draft in ${theme}`, async ({
        page,
      }, testInfo) => {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
        const fixture = await mockEvent(page, { role: 'player', bracket: true });
        Object.assign(fixture.snapshot.plan, { competitionFormat: 'singles' });
        const playing = fixture.snapshot.matches.find((match) => match.status === 'playing')!;
        const bracketMatch = fixture.snapshot.matches.find(
          (match) => match.id === 'fixture-semi-b',
        )!;
        const recorded = fixture.snapshot.matches.find(
          (match) => match.stage === 'group' && match.status === 'complete',
        )!;
        Object.assign(recorded, { division: playing.division, poolIndex: playing.poolIndex });
        const names = new Map([
          [playing.player1Id, PLAYER_NAME],
          [playing.player2Id, playing.player2Name],
          [bracketMatch.player1Id, bracketMatch.player1Name],
          [recorded.player1Id, recorded.player1Name],
        ]);
        const previews: string[] = [];
        fixture.queryResponses.set('public.playerPreview', (input) => {
          const { playerId } = input as { playerId: string };
          previews.push(playerId);
          return {
            profile: {
              name: names.get(playerId),
              characters: ['mario'],
              rating: { clubRating: 1538, wins: 8, losses: 5, isProvisional: false },
            },
            redirectTo: null,
          };
        });

        await page.goto(`/play/${PLAN_ID}?pool=${playing.division}%3A${playing.poolIndex}`);
        const card = page.locator(`[data-player-match-id="${playing.id}"]`);
        const score = card.getByRole('spinbutton').first();
        await score.fill('2');
        const url = page.url();
        const pools = page.getByRole('region', { name: 'Pools', exact: true });
        const poolRow = pools.getByRole('row', { name: new RegExp(PLAYER_NAME) }).first();
        const results = page.getByRole('region', { name: 'Results', exact: true });
        await expect(poolRow).toBeVisible();
        expect(previews).toEqual([]);

        for (const [area, name, playerId, evidence] of [
          [poolRow, PLAYER_NAME, playing.player1Id!, 'pool-preview'],
          [card, playing.player2Name!, playing.player2Id!, 'match-preview'],
          [
            page.locator(`[data-match-id="${bracketMatch.id}"]`),
            bracketMatch.player1Name!,
            bracketMatch.player1Id!,
            'bracket-preview',
          ],
          [results, recorded.player1Name!, recorded.player1Id!, 'recorded-result-preview'],
        ] as const) {
          const trigger = area.getByRole('button', { name: `Preview ${name}` });
          if (width === 390) await trigger.tap({ timeout: 3000 });
          else await trigger.press('Enter', { timeout: 3000 });
          const dialog = page.getByRole('dialog', { name, exact: true });
          await expect(dialog.getByText('1538', { exact: true })).toBeVisible();
          await expect(dialog.getByText('8–5', { exact: true })).toBeVisible();
          await expect(dialog.getByRole('link', { name: 'View full profile' })).toHaveAttribute(
            'href',
            `/players/${playerId}`,
          );
          await expect.poll(() => previews.at(-1)).toBe(playerId);
          await expect(page).toHaveURL(url);
          await ready(page);
          await page.screenshot({ path: testInfo.outputPath(`${evidence}.png`) });
          if (evidence === 'pool-preview')
            expect(
              (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
                .violations,
            ).toEqual([]);
          await page.keyboard.press('Escape');
          await expect(dialog).toBeHidden();
          await expect(trigger).toBeFocused();
          await expect(score).toHaveValue('2');
          await page.screenshot({ path: testInfo.outputPath(`${evidence}-closed.png`) });
        }

        const bracket = page.getByRole('region', { name: 'Brackets', exact: true });
        await expect(bracket.getByText('Winner of Semi-final B')).toBeVisible();
        await expect(
          bracket.getByRole('button', { name: /Preview.*(Winner|Awaiting)/ }),
        ).toHaveCount(0);
        expect(previews).toEqual([
          playing.player1Id,
          playing.player2Id,
          bracketMatch.player1Id,
          recorded.player1Id,
        ]);
        expect(fixture.submissions).toEqual([]);
        expect(fixture.unexpected).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
        expect(
          (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
            .violations,
        ).toEqual([]);
      });
  });

test('doubles team labels do not open an individual profile', async ({ page }) => {
  const fixture = await mockEvent(page, { bracket: true });
  Object.assign(fixture.snapshot.plan, { competitionFormat: 'doubles' });
  const playing = fixture.snapshot.matches.find((match) => match.status === 'playing')!;
  const team = 'Side Quest';
  Object.assign(playing, {
    player1Name: team,
    player1MemberIds: [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
    ],
  });

  await page.goto(`/play/${PLAN_ID}`);
  await expect(
    page.getByRole('region', { name: 'Pools', exact: true }).getByText(team).first(),
  ).toBeVisible();
  await expect(page.locator(`[data-player-match-id="${playing.id}"]`)).toContainText(team);
  for (const name of [team, playing.player2Name, 'Peach', 'Roy'])
    await expect(page.getByRole('button', { name: `Preview ${name}`, exact: true })).toHaveCount(0);
  expect(fixture.unexpected).toEqual([]);
});
