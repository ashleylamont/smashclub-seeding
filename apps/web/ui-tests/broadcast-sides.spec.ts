import { expect, test } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { mockEvent, PLAN_ID, ready } from './fixtures';

for (const [width, height] of [
  [1280, 720],
  [1920, 1080],
])
  test(`${width}x${height} persisted sides keep names, characters and scores together without covering capture`, async ({
    page,
  }, testInfo) => {
    const fixture = await mockEvent(page);
    await page.clock.install({ time: new Date('2026-10-04T00:00:00Z') });
    const match = fixture.snapshot.matches.find((item) => item.status === 'playing')!;
    Object.assign(match, {
      score1: 1,
      score2: 2,
      player1Characters: ['mario'],
      player2Characters: ['link'],
    });
    Object.assign(fixture.snapshot, {
      broadcastSides: {
        [match.stationId!]: {
          matchId: match.id,
          player1Id: match.player1Id,
          player2Id: match.player2Id,
          matchRevision: match.revision,
          swapped: true,
          revision: 1,
        },
      },
    });
    await page.setViewportSize({ width, height });
    await page.goto(`/overlay/${PLAN_ID}?station=${match.stationId}&recent=1&controls=0`);
    const left = page.locator('.broadcast-fighter-one'),
      right = page.locator('.broadcast-fighter-two');
    await expect(left.locator('strong')).toHaveText(match.player2Name!);
    await expect(right.locator('strong')).toHaveText(match.player1Name!);
    await expect(left.locator('b')).toHaveText('2');
    await expect(right.locator('b')).toHaveText('1');
    await expect(left.getByRole('img', { name: 'Mains Link' })).toBeVisible();
    await expect(right.getByRole('img', { name: 'Mains Mario' })).toBeVisible();
    await expect(left.locator('.broadcast-side')).toHaveText('LEFT');
    await expect(right.locator('.broadcast-side')).toHaveText('RIGHT');
    await page.reload();
    await expect(left.locator('strong')).toHaveText(match.player2Name!);
    await expect(page).toHaveURL(/recent=1&controls=0/);
    await ready(page);
    const aperture = (await page.getByLabel('Transparent game capture area').boundingBox())!;
    expect(
      await page.evaluate(
        ({ x, y }) =>
          document
            .elementsFromPoint(x, y)
            .filter(
              (element) =>
                !['transparent', 'rgba(0, 0, 0, 0)'].includes(
                  getComputedStyle(element).backgroundColor,
                ),
            ).length,
        { x: aperture.x + aperture.width / 2, y: aperture.y + aperture.height / 2 },
      ),
    ).toBe(0);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <= innerWidth &&
          document.documentElement.scrollHeight <= innerHeight,
      ),
    ).toBe(true);
    expect(
      (
        await new AxeBuilder({ page })
          .include('.event-overlay')
          .withTags(['wcag2a', 'wcag2aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`swapped-overlay-${width}.png`),
      omitBackground: true,
    });
    Object.assign(match, {
      player1Id: 'replacement-id',
      player1Name: 'Replacement entrant',
      player1Characters: ['samus'],
      revision: match.revision + 1,
    });
    await page.clock.runFor(5100);
    await expect(left.locator('strong')).toHaveText('Replacement entrant');
    await expect(left.getByRole('img', { name: 'Mains Samus' })).toBeVisible();
    await expect(left.locator('b')).toHaveText('1');
    expect(fixture.unexpected).toEqual([]);
  });

test('a lost swap acknowledgement retries the same intent and preserves canonical score drafts', async ({
  page,
}) => {
  const fixture = await mockEvent(page, { role: 'admin' });
  const match = fixture.snapshot.matches.find((item) => item.status === 'playing')!;
  Object.assign(match, { score1: 1, score2: 2 });
  const requests: unknown[] = [];
  let fail = true;
  await page.route('**/api/trpc/eventOps.live.command*', async (route) => {
    const batch = new URL(route.request().url()).searchParams.has('batch');
    const body = route.request().postDataJSON();
    const input = batch ? body[0] : body;
    requests.push(input);
    const command = input.command;
    const metadata = {
      [command.stationId]: {
        matchId: command.matchId,
        player1Id: command.player1Id,
        player2Id: command.player2Id,
        matchRevision: command.expectedMatchRevision,
        swapped: command.swapped,
        revision: 1,
      },
    };
    Object.assign(fixture.snapshot, { broadcastSides: metadata });
    if (fail) {
      fail = false;
      const error = {
        error: {
          message: 'Swap acknowledgement lost. Try again.',
          code: -32603,
          data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
        },
      };
      await route.fulfill({ status: 500, json: batch ? [error] : error });
    } else {
      Object.assign(fixture.overview, { broadcastSides: metadata });
      const response = { result: { data: { receipt: { sequence: 1 } } } };
      await route.fulfill({ json: batch ? [response] : response });
    }
  });
  await page.goto(`/operate/${PLAN_ID}?view=broadcast&station=${match.stationId}`);
  const panel = page.getByRole('tabpanel', { name: 'Broadcast' });
  await panel.getByRole('button', { name: 'Update live score', exact: true }).click();
  const form = panel.locator('.ops-score-form');
  await form.getByRole('spinbutton').nth(0).fill('3');
  await form.getByRole('spinbutton').nth(1).fill('0');
  await panel.getByRole('button', { name: 'Swap players / sides' }).click();
  await expect(page.getByRole('alert')).toContainText('Swap acknowledgement lost');
  await expect(form.getByRole('spinbutton').nth(0)).toHaveValue('3');
  await panel.getByRole('button', { name: 'Swap players / sides' }).click();
  await expect(panel.getByRole('group', { name: 'Left player' }).locator('strong')).toHaveText(
    match.player2Name!,
  );
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  await expect(form.getByRole('spinbutton').nth(0)).toHaveValue('3');
  await expect(form.getByRole('spinbutton').nth(1)).toHaveValue('0');
  await expect(form.getByRole('spinbutton').nth(0)).toHaveAccessibleName(match.player1Name!);
  await expect(form.getByRole('spinbutton').nth(1)).toHaveAccessibleName(match.player2Name!);
  await page.reload();
  await expect(panel.getByRole('group', { name: 'Left player' }).locator('strong')).toHaveText(
    match.player2Name!,
  );
  await expect(page).toHaveURL(new RegExp(`station=${match.stationId}`));
  expect(fixture.unexpected).toEqual([]);
});

test('legacy main-stage panels explain the native journal boundary and keep canonical order', async ({
  page,
}) => {
  const fixture = await mockEvent(page, { role: 'admin' });
  Object.assign(fixture.snapshot.plan, { bracketMode: 'challonge' });
  fixture.responses['eventOps.delivery.status'] = { configured: false };
  const match = fixture.snapshot.matches.find((item) => item.status === 'playing')!;
  await page.goto(`/operate/${PLAN_ID}?view=broadcast`);
  const panel = page.getByRole('tabpanel', { name: 'Broadcast' });
  await expect(panel).toContainText('Side swapping requires a native event journal');
  await expect(panel.getByRole('button', { name: 'Swap players / sides' })).toHaveCount(0);
  await expect(panel.getByRole('group', { name: 'Left player' }).locator('strong')).toHaveText(
    match.player1Name!,
  );
  expect(fixture.unexpected).toEqual([]);
});
