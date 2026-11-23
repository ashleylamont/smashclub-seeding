import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mockEvent, PLAN_ID, ready } from './fixtures';

const memberA = 'fc875fb2-ea79-4a59-873d-798ca2ba021f';
const memberB = 'fd44e7b2-b9dd-47bb-853a-747d681f6be4';
const firstAlias = 'X';
const secondAlias = 'LongTournamentAliasThatWrapsInsideTheirDoublesPair';
const pair = `${firstAlias} / ${secondAlias}`;
const team = 'Side Quest';

async function doublesEvent(page: Page, status = 'underway') {
  const fixture = await mockEvent(page, { role: 'player', bracket: true });
  Object.assign(fixture.snapshot.plan, { competitionFormat: 'doubles', status });
  Object.assign(fixture.snapshot, {
    memberNames: { [memberA]: firstAlias, [memberB]: secondAlias },
  });
  const playing = fixture.snapshot.matches.find((match) => match.status === 'playing')!;
  const semi = fixture.snapshot.matches.find((match) => match.id === 'fixture-semi-b')!;
  const recorded = fixture.snapshot.matches.find(
    (match) => match.stage === 'group' && match.status === 'complete',
  )!;
  const teamId = playing.player1Id!;
  Object.assign(semi, { player1Id: teamId });
  Object.assign(recorded, {
    player1Id: teamId,
    winnerId: teamId,
    division: playing.division,
    poolIndex: playing.poolIndex,
  });
  for (const match of fixture.snapshot.matches) {
    if (match.player1Id === teamId)
      Object.assign(match, {
        player1Name: `${team} (${pair})`,
        player1MemberIds: [memberA, memberB],
      });
    if (match.player2Id === teamId)
      Object.assign(match, {
        player2Name: `${team} (${pair})`,
        player2MemberIds: [memberA, memberB],
      });
  }
  Object.assign(playing, {
    player2Name: 'Unlinked pair',
    player2MemberIds: [playing.player2Id, '710f7156-57f1-44c2-98ef-5b5874993565'],
  });
  Object.assign(semi, { player1Name: pair });
  const requests: string[] = [];
  fixture.queryResponses.set('public.playerPreview', (input) => {
    const { playerId } = input as { playerId: string };
    requests.push(playerId);
    return {
      profile: {
        name: playerId === memberA ? firstAlias : secondAlias,
        characters: ['mario'],
        rating: { clubRating: 1538, wins: 8, losses: 5, isProvisional: false },
      },
      redirectTo: null,
    };
  });
  return { fixture, playing, semi, requests };
}

const memberButton = (area: Locator | Page, alias: string) =>
  area.getByRole('button', { name: `Preview ${alias}`, exact: true });

const axe = (page: Page) =>
  new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();

for (const width of [320, 390, 1440])
  test.describe(`${width}px doubles member profiles`, () => {
    test.use({ viewport: { width, height: 844 }, hasTouch: width < 1440 });

    for (const theme of ['dark', 'light'] as const)
      test(`opens only registered member profiles and keeps the score draft in ${theme}`, async ({
        page,
      }, testInfo) => {
        await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
        const { fixture, playing, semi, requests } = await doublesEvent(page);
        await page.goto(`/play/${PLAN_ID}?pool=${playing.division}%3A${playing.poolIndex}`);
        const card = page.locator(`[data-player-match-id="${playing.id}"]`);
        const score = card.getByRole('spinbutton').first();
        const pool = page.getByRole('region', { name: 'Pools', exact: true });
        const bracket = page.locator(`[data-match-id="${semi.id}"]`);
        const results = page.getByRole('region', { name: 'Results', exact: true });
        const result = results.locator('article.event-match').filter({ hasText: team }).first();

        await expect(pool).toContainText(team);
        await expect(card.getByText('Unlinked pair').first()).toBeVisible();
        const versus = card.getByText('vs', { exact: true });
        expect(
          await versus.evaluate((node) => {
            const text = document.createRange();
            text.selectNodeContents(node);
            return text.getClientRects().length;
          }),
        ).toBe(1);
        await expect(results).toContainText(team);
        await score.fill('2');
        expect(requests).toEqual([]);

        for (const [name, area] of [
          ['match', card],
          ['pool', pool],
          ['bracket', bracket],
          ['result', result],
        ] as const) {
          const first = area.getByRole('button', { name: `Preview ${firstAlias}`, exact: true });
          const second = memberButton(area, secondAlias);
          for (const trigger of [first, second]) {
            await expect(trigger).toBeVisible();
            if (width < 1440) {
              const { width, height } = (await trigger.boundingBox())!;
              expect(width).toBeGreaterThanOrEqual(44);
              expect(height).toBeGreaterThanOrEqual(44);
            }
          }
          const a = (await first.boundingBox())!;
          const b = (await second.boundingBox())!;
          expect(
            a.x >= b.x + b.width ||
              a.x + a.width <= b.x ||
              a.y >= b.y + b.height ||
              a.y + a.height <= b.y,
          ).toBe(true);
          await first.evaluate((node) =>
            node.scrollIntoView({ block: 'center', inline: 'nearest' }),
          );
          await ready(page);
          await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
        }

        for (const name of [team, 'Unlinked pair', 'Winner of Semi-final B'])
          await expect(memberButton(page, name)).toHaveCount(0);

        const trigger = memberButton(card, secondAlias);
        if (width < 1440) await trigger.tap();
        else await trigger.press('Enter');
        const dialog = page.getByRole('dialog', { name: secondAlias });
        await expect(dialog.getByText('1538', { exact: true })).toBeVisible();
        await expect(dialog.getByRole('link', { name: 'View full profile' })).toHaveAttribute(
          'href',
          `/players/${memberB}`,
        );
        expect(requests).toEqual([memberB]);
        expect((await axe(page)).violations).toEqual([]);
        await page.screenshot({ path: testInfo.outputPath('profile-preview.png') });
        await page.keyboard.press('Escape');
        await expect(trigger).toBeFocused();
        await expect(score).toHaveValue('2');
        expect(fixture.submissions).toEqual([]);
        expect(fixture.unexpected).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
        expect((await axe(page)).violations).toEqual([]);
      });
  });

test('the native doubles archive links recorded members without opening a report form', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { fixture, playing, requests } = await doublesEvent(page, 'complete');
  await page.goto(`/play/${PLAN_ID}?pool=${playing.division}%3A${playing.poolIndex}#results`);
  const results = page.getByRole('region', { name: 'Results', exact: true });
  const trigger = memberButton(results, firstAlias).first();
  await expect(trigger).toBeVisible();
  expect(requests).toEqual([]);
  await trigger.press('Enter');
  await expect(page.getByRole('link', { name: 'View full profile' })).toHaveAttribute(
    'href',
    `/players/${memberA}`,
  );
  await expect.poll(() => requests).toEqual([memberA]);
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(page.getByRole('spinbutton')).toHaveCount(0);
  expect(fixture.submissions).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
  await ready(page);
  await page.screenshot({ path: testInfo.outputPath('native-doubles-archive.png') });
});
