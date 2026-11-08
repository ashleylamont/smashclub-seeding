import { AxeBuilder } from '@axe-core/playwright';
import { darwinBaseline, darwinScreenshot } from './darwinScreenshot';
import { expect, test, type Page } from '@playwright/test';
import { mockEvent, PLAN_ID, ready } from './fixtures';
import { bracketFixture, TEAM_ALIAS } from '../test/fixtures/brackets';
import { chooseOption } from '../test-support/controls';
import { broadcastProgressPages } from '../src/lib/broadcastProgress';
import type { LiveMatch } from '../src/lib/eventDisplay';
import type { PublicFinalsField } from '../src/lib/qualification';

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
  test(
    `${width}px intermission pages keep every DE match readable, including long pairs and the conditional reset`,
    darwinBaseline,
    async ({ page }, testInfo) => {
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
      await darwinScreenshot(page, `intermission-bracket-${width}.png`);
      expect(fixture.unexpected).toEqual([]);
    },
  );

  test(
    `${width}px pool pages show all records without claiming confirmed places`,
    darwinBaseline,
    async ({ page }, testInfo) => {
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
      await darwinScreenshot(page, `intermission-pools-${width}.png`);
      expect(fixture.unexpected).toEqual([]);
    },
  );
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
  const interruption = page.getByText('Connection interrupted · last received scores', {
    exact: true,
  });
  // A failed poll schedules a retry only after its response has been handled.
  // Keep advancing the clock while the browser processes those network responses.
  await expect
    .poll(async () => {
      await page.clock.runFor(2000);
      return interruption.isVisible();
    })
    .toBe(true);
  await expect(progress).toBeVisible();
  await expect(progress).toContainText('Page 2 /');
});

for (const [width, theme] of [
  [1280, 'dark'],
  [1920, 'light'],
] as const) {
  test(`${width}px linked finals show published matches without guessing the draw`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: (width * 9) / 16 });
    await page.emulateMedia({ colorScheme: theme });
    await page.clock.install({ time: new Date('2026-10-04T00:00:00Z') });
    const fixture = await mockEvent(page, { idle: true });
    const [station, other] = fixture.snapshot.stations;
    const pool = fixture.snapshot.matches.find((match) => match.stage === 'group')!;
    const linked = (label: string, facts: Partial<LiveMatch> = {}): LiveMatch => ({
      ...pool,
      id: `linked-${label}`,
      label,
      sourceSetId: `source-${label}`,
      nativeBracketId: null,
      poolIndex: null,
      division: 'upper',
      stage: 'main',
      status: 'ready',
      outcome: null,
      score1: null,
      score2: null,
      winnerId: null,
      stationId: null,
      called: false,
      ...facts,
    });
    const played = linked('Imported played set', {
      status: 'complete',
      outcome: 'played',
      score1: 2,
      score2: 0,
      winnerId: pool.player1Id,
      player1Name: TEAM_ALIAS,
      player2Name: `West · ${TEAM_ALIAS}`,
    });
    const forfeit = linked('Imported forfeit', {
      status: 'complete',
      outcome: 'forfeit',
      score1: -1,
      score2: 0,
      winnerId: pool.player2Id,
    });
    const bye = linked('Imported bye', {
      status: 'complete',
      outcome: 'bye',
      score1: 99,
      score2: 0,
      winnerId: pool.player1Id,
      player2Id: null,
    });
    const pending = linked('Imported pending set', {
      status: 'blocked',
      player1Id: null,
      player2Id: null,
      player1Name: 'TBD',
      player2Name: 'TBD',
    });
    const lower = linked('Imported consolation set', {
      division: 'lower',
      stage: 'consolation',
    });
    fixture.responses['eventOps.snapshot'] = {
      ...fixture.snapshot,
      plan: { ...fixture.snapshot.plan, bracketMode: 'challonge' },
      nativeBrackets: [],
      matches: [pool, played, forfeit, bye, pending, lower],
      brackets: [
        { division: 'upper', stage: 'main', slug: 'linked-upper' },
        { division: 'lower', stage: 'consolation', slug: 'linked-lower' },
      ],
    };
    await page.goto(`/overlay/${PLAN_ID}?station=${station!.id}&presentation=auto&controls=0`);
    const progress = page.getByRole('region', { name: 'Tournament progress', exact: true });
    await expect(progress.getByRole('heading', { name: /pool/i })).toBeVisible();
    await page.keyboard.press('ArrowRight');
    const upper = progress.getByRole('table', { name: 'Linked Upper Championship bracket' });
    await expect(progress).toContainText('Section 1 / 2');
    await expect(upper.getByRole('row', { name: /Imported played set/ })).toContainText('2–0');
    await expect(upper.getByRole('row', { name: /Imported played set/ })).toContainText(
      `${TEAM_ALIAS} · Winner`,
    );
    await expect(upper.getByRole('row', { name: /Imported forfeit/ })).toContainText('Forfeit');
    await expect(upper.getByRole('row', { name: /Imported bye/ })).toContainText('Bye');
    await expect(upper).not.toContainText(/-1–0|99–0/);
    await expect(progress.locator('path[data-feed-from]')).toHaveCount(0);
    await fits(page);
    await page.screenshot({ path: testInfo.outputPath(`intermission-linked-${width}.png`) });
    expect(
      (
        await new AxeBuilder({ page })
          .include('.broadcast-intermission')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);

    await page.keyboard.press('ArrowRight');
    await expect(progress).toContainText('Section 2 / 2');
    await expect(upper).toContainText('Awaiting opponent');
    await expect(upper).not.toContainText('TBD');
    await fits(page);
    await page.keyboard.press('ArrowRight');
    const lowerTable = progress.getByRole('table', { name: 'Linked Lower Consolation bracket' });
    await expect(lowerTable).toContainText(lower.label);

    Object.assign(lower, { status: 'playing', stationId: other!.id });
    await page.clock.runFor(5000);
    await expect(lowerTable).toContainText('Playing');
    Object.assign(lower, { stationId: station!.id });
    await page.clock.runFor(5000);
    await expect(progress).not.toBeVisible();
    await expect(page.getByRole('region', { name: 'Transparent game capture area' })).toBeVisible();
    Object.assign(lower, {
      status: 'complete',
      outcome: 'played',
      score1: 1,
      score2: 2,
      winnerId: lower.player2Id,
    });
    await page.clock.runFor(5000);
    await expect(progress).toBeVisible();
    await page.keyboard.press('ArrowLeft');
    await expect(lowerTable).toContainText('1–2');
    expect(fixture.unexpected).toEqual([]);
  });
}

for (const [width, height, theme] of [
  [390, 844, 'dark'],
  [1280, 720, 'dark'],
  [1920, 1080, 'light'],
] as const) {
  test(`${width}px intermission pages show qualifiers before pairings are published`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: theme });
    await page.clock.install({ time: new Date('2026-10-04T00:00:00Z') });
    const fixture = await mockEvent(page, { idle: true, bracket: true });
    const { snapshot } = fixture;
    const id = snapshot.nativeBrackets[0]!.entrantIds[0]!;
    snapshot.entrants.find((entrant) => entrant.id === id)!.name = TEAM_ALIAS;
    const fields: PublicFinalsField[] = (['upper', 'lower'] as const).map((division) => ({
      division,
      stage: 'main',
      slots: [0, 1].flatMap((poolIndex) =>
        [1, 2, 3].map((place) => ({
          poolId: `${division}-${poolIndex}`,
          poolIndex,
          place,
          division,
          status:
            division === 'lower' && poolIndex === 1
              ? 'review_pending'
              : division === 'upper' && poolIndex === 0 && place === 1
                ? 'resolved'
                : 'pending',
          entrantId: division === 'upper' && poolIndex === 0 && place === 1 ? id : null,
        })),
      ),
    }));
    const pools = {
      ...snapshot,
      matches: snapshot.matches.filter((match) => !match.nativeBracketId),
      nativeBrackets: [],
      pendingFinals: fields,
    };
    fixture.responses['eventOps.snapshot'] = pools;
    await page.goto(`/overlay/${PLAN_ID}?presentation=progress&controls=0`);
    const progress = page.getByRole('region', { name: 'Tournament progress', exact: true });
    await expect(progress.getByRole('table')).toBeVisible();
    const pages = broadcastProgressPages(pools);
    const firstQualifier = pages.findIndex((item) => item.kind === 'qualification');
    const upperHeading = progress.getByRole('heading', {
      name: 'Upper Championship qualification',
    });
    const lowerHeading = progress.getByRole('heading', {
      name: 'Lower Championship qualification',
    });
    const seen = new Set<string>();
    for (let index = 0; index < pages.length; index++) {
      await expect(progress).toContainText(`Page ${index + 1} / ${pages.length}`);
      if (index >= firstQualifier) {
        await fits(page);
        const table = progress.getByRole('table');
        const labels = await table.getByRole('row').getByRole('cell').allTextContents();
        labels.filter((label) => label.includes('Pool')).forEach((label) => seen.add(label));
        await expect(progress.locator('.event-bracket-match')).toHaveCount(0);
        if (index === firstQualifier) {
          await expect(upperHeading).toBeVisible();
          await expect(table).toContainText(TEAM_ALIAS);
          await expect(table).toContainText('Awaiting qualification');
          await expect(progress).toContainText('Section 1 / 2');
          await page.screenshot({
            path: testInfo.outputPath(`intermission-qualification-${width}.png`),
          });
          expect(
            (
              await new AxeBuilder({ page })
                .include('.broadcast-intermission')
                .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
                .analyze()
            ).violations,
          ).toEqual([]);
        }
      }
      if (index < pages.length - 1) await page.keyboard.press('ArrowRight');
    }
    expect(seen.size).toBe(12);
    await expect(lowerHeading).toBeVisible();
    await expect(progress).toContainText('Under score review');

    // The next poll publishes one bracket while keeping the other field and its active page.
    const mixed = { ...snapshot, pendingFinals: fields.slice(1) };
    fixture.responses['eventOps.snapshot'] = mixed;
    const mixedPages = broadcastProgressPages(mixed);
    const lastPage = `Page ${mixedPages.length} / ${mixedPages.length}`;
    await expect
      .poll(async () => {
        await page.clock.runFor(2000);
        return progress.getByText(lastPage, { exact: false }).isVisible();
      })
      .toBe(true);
    await expect(lowerHeading).toBeVisible();
    await expect(progress).toContainText('Section 2 / 2');
    const firstDraw = mixedPages.findIndex((item) => item.kind === 'bracket');
    for (let i = mixedPages.length - 1; i > firstDraw; i--) await page.keyboard.press('ArrowLeft');
    await expect(progress.locator('.event-bracket-match').first()).toBeVisible();
    await expect(upperHeading).toHaveCount(0);
    expect(fixture.unexpected).toEqual([]);
  });
}
