import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mockEvent, PLAN_ID, ready } from './fixtures';
import { bracketFixture, TEAM_ALIAS } from '../test/fixtures/brackets';
import { chooseOption } from '../test-support/controls';
import { broadcastProgressPages } from '../src/lib/broadcastProgress';

async function fits(page: Page) {
  await ready(page);
  await expect
    .poll(async () =>
      page.locator('.intermission-content').evaluate((element) => ({
        width: element.scrollWidth <= element.clientWidth + 1,
        height: element.scrollHeight <= element.clientHeight + 1,
      })),
    )
    .toEqual({ width: true, height: true });
  await expect
    .poll(() =>
      page
        .locator(
          '.intermission-heading h1, .intermission-section-heading h2, .intermission-section-heading > span, .intermission-standings td, .event-bracket-match small, .event-bracket-match > div > span',
        )
        .evaluateAll((elements) =>
          elements
            .filter((element) => {
              const box = element.getBoundingClientRect();
              return (
                element.scrollWidth > element.clientWidth + 1 ||
                box.right > innerWidth + 1 ||
                box.left < -1
              );
            })
            .map((element) => ({
              text: element.textContent,
              width: element.clientWidth,
              scroll: element.scrollWidth,
              right: element.getBoundingClientRect().right,
              position: getComputedStyle(element).position,
            })),
        ),
    )
    .toEqual([]);
  for (const region of await page.locator('.event-bracket-rounds').all())
    expect(await region.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true,
    );
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= innerWidth &&
        document.documentElement.scrollHeight <= innerHeight,
    ),
  ).toBe(true);
}

for (const width of [1280, 1920]) {
  test(`${width}px intermission pages keep every DE match readable, including long pairs and the conditional reset`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: (width * 9) / 16 });
    await page.emulateMedia({ colorScheme: 'light' });
    const fixture = await mockEvent(page, { idle: true, bracket: true });
    const matches = bracketFixture(7);
    for (const match of matches) {
      if (match.player1Id) match.player1Name = TEAM_ALIAS;
      if (match.player2Id) match.player2Name = TEAM_ALIAS;
    }
    Object.assign(fixture.snapshot, {
      matches,
      stationQueues: [],
      poolRounds: [],
      nativeBrackets: [
        {
          id: 'rehearsal',
          division: 'upper',
          stage: 'main',
          entrantIds: Array.from({ length: 7 }, (_, i) => `entrant-${i}`),
          complete: false,
          winnerId: null,
          standings: [],
        },
      ],
    });
    await page.goto(`/overlay/${PLAN_ID}?presentation=progress`);
    const progress = page.getByRole('region', { name: 'Tournament progress', exact: true });
    await expect(
      progress.getByRole('heading', { name: fixture.snapshot.plan.name, exact: true }),
    ).toBeVisible();
    const pages = broadcastProgressPages(fixture.snapshot);
    const seen = new Set<string>();
    let resetCaptured = false;
    for (let index = 0; index < pages.length; index++) {
      await expect(progress).toContainText(`Page ${index + 1} / ${pages.length}`);
      await fits(page);
      for (const card of await page.locator('.event-bracket-match').all())
        seen.add((await card.getAttribute('data-match-id'))!);
      const progressPage = pages[index]!;
      if (
        index === 0 ||
        (!resetCaptured && progressPage.kind === 'bracket' && progressPage.lane.key === 'finals')
      ) {
        const kind = index === 0 ? 'bracket' : 'reset';
        await page.mouse.move(0, 0);
        await page.screenshot({ path: testInfo.outputPath(`intermission-${kind}-${width}.png`) });
        if (kind === 'reset') {
          resetCaptured = true;
          await expect(progress).toContainText('If needed');
        }
      }
      if (index < pages.length - 1)
        await page.getByRole('button', { name: 'Next page', exact: true }).click();
    }
    expect(seen).toEqual(new Set(matches.map((match) => match.id)));
    expect(resetCaptured).toBe(true);
    expect(
      (
        await new AxeBuilder({ page })
          .include('.broadcast-intermission')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.getByRole('button', { name: 'Next page', exact: true }).click();
    await page.mouse.move(0, 0);
    await expect(page).toHaveScreenshot(`intermission-bracket-${width}.png`);
    expect(fixture.unexpected).toEqual([]);
  });

  test(`${width}px pool pages show all records without claiming confirmed places`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: (width * 9) / 16 });
    const fixture = await mockEvent(page, { idle: true });
    await page.goto(`/overlay/${PLAN_ID}?presentation=progress&controls=0`);
    const progress = page.getByRole('region', { name: 'Tournament progress', exact: true });
    await expect(progress.getByRole('table')).toBeVisible();
    await expect(progress).toContainText('Pool order and final seeds are separate decisions');
    await fits(page);
    expect(
      (
        await new AxeBuilder({ page })
          .include('.broadcast-intermission')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`intermission-pools-${width}.png`) });
    await expect(page).toHaveScreenshot(`intermission-pools-${width}.png`);
    expect(fixture.unexpected).toEqual([]);
  });
}

test('automatic source rotates, pauses, hands off to the selected station and returns after its result', async ({
  page,
}) => {
  await page.clock.install({ time: new Date('2026-10-04T00:00:00Z') });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const fixture = await mockEvent(page, { idle: true, bracket: true });
  const station = fixture.snapshot.stations[0]!;
  await page.goto(`/overlay/${PLAN_ID}?station=${station.id}&presentation=auto&cycleSeconds=15`);
  const progress = page.getByRole('region', { name: 'Tournament progress', exact: true });
  await expect(progress).toContainText('Page 1 /');
  await page.clock.fastForward(15000);
  await expect(progress).toContainText('Page 2 /');
  await page.getByRole('button', { name: 'Pause rotation', exact: true }).click();
  await page.clock.fastForward(60000);
  await expect(progress).toContainText('Page 2 /');
  await page.getByRole('button', { name: 'Resume rotation', exact: true }).click();
  await page.clock.fastForward(15000);
  await expect(progress).not.toContainText('Page 2 /');
  const match = fixture.snapshot.matches.find((item) => item.player1Id && item.player2Id)!;
  Object.assign(match, { status: 'playing', stationId: station.id });
  Object.assign(station, { currentMatchId: match.id, status: 'occupied' });
  await page.clock.fastForward(5000);
  await expect(progress).not.toBeVisible();
  await expect(page.getByRole('region', { name: 'Transparent game capture area' })).toBeVisible();
  await expect(page.getByLabel('Current match')).toContainText(match.player1Name!);
  Object.assign(match, {
    status: 'complete',
    outcome: 'played',
    winnerId: match.player1Id,
    score1: 2,
    score2: 0,
  });
  Object.assign(station, { currentMatchId: null, status: 'free' });
  await page.clock.fastForward(5000);
  await expect(progress).toBeVisible();
  await page.keyboard.press('s');
  const setup = page.getByRole('dialog', { name: 'Display setup', exact: true });
  await chooseOption(
    setup.getByRole('combobox', { name: 'Broadcast presentation', exact: true }),
    'gameplay',
  );
  await expect(page).toHaveURL(/presentation=gameplay/);
  await setup.getByRole('button', { name: 'Hide controls', exact: true }).click();
  await expect(progress).not.toBeVisible();
  await expect(page.getByRole('region', { name: 'Transparent game capture area' })).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
});

test('reduced motion retains manual pages, and interruptions keep the last known data', async ({
  page,
}) => {
  await page.clock.install({ time: new Date('2026-10-04T00:00:00Z') });
  const options = { idle: true, bracket: true, failure: false };
  await mockEvent(page, options);
  await page.goto(`/overlay/${PLAN_ID}?presentation=progress&controls=0`);
  const progress = page.getByRole('region', { name: 'Tournament progress', exact: true });
  await expect(progress).toContainText('Page 1 /');
  await expect(progress).toContainText('manual pages');
  await page.clock.fastForward(60000);
  await expect(progress).toContainText('Page 1 /');
  await page.keyboard.press('ArrowRight');
  await expect(progress).toContainText('Page 2 /');
  options.failure = true;
  await page.clock.fastForward(10000);
  await expect(
    page.getByText('Connection interrupted · last received scores', { exact: true }),
  ).toBeVisible();
  await expect(progress).toBeVisible();
  await expect(progress).toContainText('Page 2 /');
});
