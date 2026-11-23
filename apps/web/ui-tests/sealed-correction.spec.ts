import { readFile } from 'node:fs/promises';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { chooseOption } from '../test-support/controls';
import { bracketCaptureOptions, mockEvent, PLAN_ID, PLAYER_NAME, ready } from './fixtures';

const originalResult = 'b4036118-6ccf-41bd-a0f8-d821186bc405';
const latestResult = '3edae4ab-15c4-4b7e-ad76-9757e396b679';
const publishedStatus = 'Live play ended. Score corrections are in Standings / draw.';

async function sealedResult(page: Page, structure = 'single_elimination') {
  const fixture = await mockEvent(page, { role: 'player' });
  const match = fixture.overview.matches.find((item) => item.outcome === 'played')!;
  Object.assign(match, { player1Name: PLAYER_NAME });
  const currentPublication = {
    resultId: originalResult,
    revision: 1,
    status: 'published',
    tournamentIds: [],
  };
  Object.assign(fixture.overview.plan, { status: 'complete', structure });
  Object.assign(fixture.overview, { finalization: null });
  Object.assign(fixture.overview, { publication: currentPublication });
  const writes: unknown[] = [];
  fixture.mutationResponses.set('eventOps.live.command', (input) => {
    writes.push(input);
    return { publicationStatus: 'published' };
  });
  const open = async () => {
    await page.goto(`/operate/${PLAN_ID}?view=draw`);
    const correction = page.locator('section.card').filter({
      has: page.getByRole('heading', { name: 'Published results and corrections', exact: true }),
    });
    await expect(correction).toContainText('Result revision 1 published.');
    await chooseOption(correction.getByRole('combobox', { name: 'Completed match' }), match.id);
    const first = correction.getByRole('spinbutton', { name: PLAYER_NAME });
    const second = correction.getByRole('spinbutton', { name: match.player2Name! });
    const reason = correction.getByRole('textbox', { name: 'Ruling reason' });
    await expect(first).toHaveValue('2');
    await second.fill('1');
    await reason.fill('Reviewed footage showed one more game.');
    return { correction, first, second, reason };
  };
  return { fixture, match, currentPublication, writes, open };
}

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test(`${theme} ${width}px a newer sealed revision preserves and blocks an open correction draft`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const { match, currentPublication, writes, open } = await sealedResult(page);
      const { correction, first, second, reason } = await open();
      const publish = correction.getByRole('button', { name: 'Publish reviewed correction' });
      await expect(publish).toBeEnabled();
      await expect(page.getByText(publishedStatus, { exact: true })).toBeVisible();

      Object.assign(currentPublication, { resultId: latestResult, revision: 2 });
      Object.assign(match, { revision: match.revision + 1, score1: 3, score2: 0 });
      await expect(correction).toContainText('Result revision 2 published.');
      await expect(first).toHaveValue('2');
      await expect(second).toHaveValue('1');
      await expect(reason).toHaveValue('Reviewed footage showed one more game.');
      await expect(publish).toBeDisabled();
      await expect(correction).toContainText(`${PLAYER_NAME} 3–0 ${match.player2Name}`);

      const review = correction.getByRole('button', { name: 'Keep draft for revision 2' });
      await review.focus();
      await expect(review).toBeFocused();
      await ready(page);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBeTruthy();
      expect(
        (
          await new AxeBuilder({ page })
            .include('.ops-page')
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      await page.screenshot({
        fullPage: true,
        style: await readFile(bracketCaptureOptions.stylePath, 'utf8'),
        path: testInfo.outputPath('stale-sealed-correction.png'),
      });
      await review.press('Enter');
      await expect(reason).toBeFocused();
      await expect(first).toHaveValue('2');
      await expect(second).toHaveValue('1');
      await expect(publish).toBeEnabled();
      expect(writes).toHaveLength(0);
      await publish.focus();
      await expect(publish).toBeFocused();
      await publish.press('Enter');
      await expect
        .poll(() => writes)
        .toMatchObject([
          {
            command: {
              kind: 'replaceResult',
              resultId: latestResult,
              corrections: [{ expectedRevision: match.revision, score1: 2, score2: 1 }],
            },
          },
        ]);
      await expect(correction.getByRole('combobox', { name: 'Completed match' })).toContainText(
        'Choose a match',
      );
    });

test('an interrupted correction retries its exact command after publication advances', async ({
  page,
}) => {
  const { match, currentPublication, writes, open } = await sealedResult(page);
  const originalMatchRevision = match.revision;
  const { correction, second, reason } = await open();
  const publish = correction.getByRole('button', { name: 'Publish reviewed correction' });
  const record = () => {
    Object.assign(currentPublication, { resultId: latestResult, revision: 2, status: 'pending' });
    Object.assign(match, { revision: originalMatchRevision + 1, score1: 2, score2: 1 });
  };
  await page.route(
    '**/api/trpc/eventOps.live.command*',
    async (route) => {
      const raw = route.request().postDataJSON();
      writes.push(new URL(route.request().url()).searchParams.has('batch') ? raw[0] : raw);
      record();
      await route.abort('connectionreset');
    },
    { times: 1 },
  );

  await publish.focus();
  await publish.press('Enter');
  const retry = correction.getByRole('button', { name: 'Retry correction' });
  await expect(retry).toBeEnabled();
  await expect(retry).toBeFocused();
  await expect(correction).toContainText('Results are sealed and publication is pending.');
  await expect(page.getByText('Live play ended.', { exact: true })).toBeVisible();
  await expect(page.getByText(publishedStatus, { exact: true })).toHaveCount(0);
  await expect(second).toHaveValue('1');
  await expect(reason).toHaveValue('Reviewed footage showed one more game.');
  await retry.press('Enter');
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[0]).toMatchObject({
    command: {
      resultId: originalResult,
      corrections: [{ expectedRevision: originalMatchRevision }],
    },
  });
  expect(writes[1]).toEqual(writes[0]);
  const picker = correction.getByRole('combobox', { name: 'Completed match' });
  await expect(picker).toContainText('Choose a match');
  await expect(picker).toBeFocused();
});

for (const keepEditedOrder of [false, true])
  test(`reviewing a newer round-robin revision ${keepEditedOrder ? 'keeps a changed draft order' : 'adopts its order after draft edits are reversed'}`, async ({
    page,
  }) => {
    const { fixture, currentPublication, writes, open } = await sealedResult(page, 'round_robin');
    const placements = fixture.overview.placements
      .filter(({ division, poolIndex }) => division === 'lower' && poolIndex === 0)
      .sort((a, b) => a.place - b.place);
    Object.assign(fixture.overview, { placements });
    const [first, second, third, ...remaining] = placements.map(({ playerId }) => playerId);
    const { correction } = await open();
    const name = (id: string) => fixture.overview.entrants.find((item) => item.id === id)!.name;
    const place = (index: number) =>
      correction.getByRole('combobox', { name: `Place ${index}`, exact: true });
    await expect(place(1)).toHaveText(new RegExp(name(first!)));
    await chooseOption(place(1), third!);
    if (keepEditedOrder) await chooseOption(place(3), first!);
    else await chooseOption(place(1), first!);
    const beforeReview = keepEditedOrder ? third! : first!;

    Object.assign(currentPublication, { resultId: latestResult, revision: 2 });
    Object.assign(placements[0]!, { place: 2 });
    Object.assign(placements[1]!, { place: 1 });
    await expect(correction).toContainText('Result revision 2 published.');
    const order = correction.getByRole('list', { name: 'Latest finishing order' });
    await expect(order.getByRole('listitem').first()).toHaveText(name(second!));
    await expect(place(1)).toHaveText(new RegExp(name(beforeReview)));
    await correction.getByRole('button', { name: 'Keep draft for revision 2' }).click();

    const expected = keepEditedOrder
      ? [third!, second!, first!, ...remaining]
      : [second!, first!, third!, ...remaining];
    await expect(place(1)).toHaveText(new RegExp(name(expected[0]!)));
    await correction.getByRole('button', { name: 'Publish reviewed correction' }).click();
    await expect
      .poll(() => writes)
      .toMatchObject([{ command: { resultId: latestResult, roundRobinOrder: expected } }]);
  });

for (const state of ['cancelled', 'imported', 'blocked'] as const)
  test(`${state} desk describes the event without promising score corrections`, async ({
    page,
  }) => {
    const { fixture, currentPublication, writes } = await sealedResult(page);
    if (state === 'cancelled') fixture.overview.plan.status = 'cancelled';
    if (state === 'imported') {
      fixture.overview.plan.bracketMode = 'challonge';
      fixture.responses['eventOps.delivery.status'] = { enabled: false };
    }
    if (state === 'blocked') currentPublication.status = 'blocked';
    else Reflect.deleteProperty(fixture.overview, 'publication');

    await page.goto(`/operate/${PLAN_ID}?view=draw`);
    await expect(
      page.getByText(state === 'cancelled' ? 'Event cancelled.' : 'Live play ended.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByText(publishedStatus, { exact: true })).toHaveCount(0);
    if (state === 'blocked') {
      await expect(page.getByRole('button', { name: 'Retry result publication' })).toBeEnabled();
      await expect(
        page.getByRole('button', { name: 'Publish reviewed correction' }),
      ).toBeDisabled();
    } else {
      await expect(page.getByRole('button', { name: 'Publish reviewed correction' })).toHaveCount(
        0,
      );
    }
    if (state === 'imported') {
      await page.getByRole('button', { name: 'Challonge integration' }).press('Enter');
      await expect(
        page.getByRole('button', { name: 'Refresh all linked brackets' }),
      ).toBeDisabled();
    }
    expect(writes).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
