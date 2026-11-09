import { AxeBuilder } from '@axe-core/playwright';
import { darwinBaseline, darwinScreenshot } from './darwinScreenshot';
import { expect, test, type Page } from '@playwright/test';
import { mockEvent, PLAN_ID, ready } from './fixtures';
import { bracketFixture, TEAM_ALIAS } from '../test/fixtures/brackets';
import { chooseOption } from '../test-support/controls';
import { rpcProcedures } from '../test-support/rpcBatch';
import { broadcastProgressPages } from '../src/lib/broadcastProgress';
import type { LiveMatch } from '../src/lib/eventDisplay';
import type { PublicFinalsField } from '../src/lib/qualification';

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test(`${theme} ${width}px broadcast summary uses the short code on its own origin`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ colorScheme: theme });
      await page.addInitScript((theme) => localStorage.setItem('smashclub:theme', theme), theme);
      const { snapshot, responses, unexpected } = await mockEvent(page, { idle: true });
      const publicCode = 1000427;
      const event = {
        ...snapshot,
        publicCode,
        matches:
          width === 390
            ? []
            : snapshot.matches.filter(({ status }) => status === 'complete').slice(0, 1),
        nativeBrackets: [],
        plan: { ...snapshot.plan, status: width === 390 ? 'underway' : 'complete' },
      };
      responses['eventOps.snapshot'] = event;
      responses['eventOps.resolvePublicCode'] = { planId: PLAN_ID };
      await page.goto(`/overlay/${PLAN_ID}?presentation=progress&controls=0`);
      const progress = page.getByRole('region', { name: 'Tournament progress', exact: true });
      await expect(progress).toBeVisible();
      if (width !== 390) await page.keyboard.press('ArrowLeft');
      else {
        await expect(progress.getByRole('heading', { name: 'Waiting for the draw' })).toBeVisible();
        await expect(progress).toContainText('Page 1 / 1');
        await expect(progress.getByRole('progressbar')).toHaveCount(0);
        await expect(progress).not.toContainText('0 / 0');
      }
      const shortUrl = `${new URL(page.url()).origin}/e/${publicCode}`;
      await expect(progress).toContainText(`Event info & results ${shortUrl}`);
      await fits(page);
      expect(
        (await new AxeBuilder({ page }).include('.broadcast-intermission').analyze()).violations,
      ).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath('broadcast-short-link.png'),
        fullPage: true,
      });

      if (theme === 'dark' && width === 390)
        await page.route(
          (url) => rpcProcedures(url.href).includes('eventOps.resolvePublicCode'),
          (route) => route.abort(),
          { times: 1 },
        );
      await page.goto(`${shortUrl}?pool=upper%3A0#results`);
      if (theme === 'dark' && width === 390) {
        await expect(page.getByRole('alert')).toContainText('Could not open the event link.');
        await page.getByRole('button', { name: 'Try again' }).press('Enter');
      }
      await expect(page).toHaveURL(
        (url) =>
          url.pathname === `/play/${PLAN_ID}` &&
          url.searchParams.get('pool') === 'upper:0' &&
          url.hash === '#results',
      );
      await expect(page.getByRole('heading', { name: snapshot.plan.name })).toBeVisible();
      expect(unexpected).toEqual([]);
    });

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
          '.intermission-heading h1, .intermission-section-heading h2, .intermission-pool-status, .intermission-standings td, .event-bracket-match small, .event-bracket-match > div > span, .intermission-footer button, .intermission-pagination',
        )
        .evaluateAll((elements) =>
          elements
            .filter((element) => {
              const box = element.getBoundingClientRect();
              return (
                element.scrollWidth > element.clientWidth + 1 ||
                box.right > innerWidth + 1 ||
                box.bottom > innerHeight + 1 ||
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
      await expect(progress).toContainText('10 / 10 sets complete');
      const poolMeter = progress.getByRole('progressbar', { name: 'Pool sets completed' });
      await expect(poolMeter).toHaveAttribute('value', '10');
      await expect(poolMeter).toHaveAttribute('max', '10');
      await expect(progress).not.toContainText(/Section \d+ \/|final seeds are separate decisions/);
      await expect(progress.getByText(/^Page \d+ \/ \d+$/)).toHaveCount(1);
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
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.clock.install({ time: new Date('2026-10-04T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-04T00:01:00Z'));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const fixture = await mockEvent(page, { idle: true, bracket: true });
  const station = fixture.snapshot.stations[0]!;
  await page.goto(`/overlay/${PLAN_ID}?station=${station.id}`);
  const progress = page.getByRole('region', { name: 'Tournament progress', exact: true });
  // An in-flight snapshot can still describe the previous station state after the clock advances.
  const advanceUntilProgress = (visible: boolean) =>
    expect
      .poll(async () => {
        await page.clock.runFor(2000);
        return progress.isVisible();
      })
      .toBe(visible);
  const meter = progress.getByRole('progressbar', { name: 'Page rotation' });
  await expect
    .poll(async () => {
      await page.clock.runFor(50);
      return meter.isVisible();
    })
    .toBe(true);
  await expect(progress).toContainText('Page 1 /');
  await expect(progress.getByRole('heading', { name: 'Recent results' })).toBeVisible();
  await expect(meter).toHaveAttribute('max', '10000');
  await page.clock.fastForward(5000);
  await expect(progress).toContainText('Page 1 /');
  expect(Number(await meter.getAttribute('value'))).toBeGreaterThanOrEqual(5000);
  expect(Number(await meter.getAttribute('value'))).toBeLessThanOrEqual(5050);
  await expect(meter).toHaveAttribute('aria-valuetext', '5 seconds until next page');
  await expect(progress.getByText('5s', { exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready.then(() => true));
  await page.screenshot({ path: testInfo.outputPath('intermission-timer-1280.png') });
  await progress.getByRole('button', { name: 'Next page', exact: true }).press('Enter');
  await expect(progress).toContainText('Page 2 /');
  await expect(meter).toHaveAttribute('value', '0');
  await page.clock.fastForward(5000);
  await expect(progress).toContainText('Page 2 /');
  await expect(meter).toHaveAttribute('value', '5000');
  await page.clock.fastForward(5000);
  await expect(progress).toContainText('Page 3 /');
  await expect(meter).toHaveAttribute('value', '0');
  await progress.getByRole('button', { name: 'Pause rotation', exact: true }).press('Enter');
  await expect(progress.getByText('Paused', { exact: true })).toBeVisible();
  await expect(meter).toHaveCount(0);
  await page.clock.fastForward(60000);
  await expect(progress).toContainText('Page 3 /');
  await progress.getByRole('button', { name: 'Resume rotation', exact: true }).press('Enter');
  await expect(meter).toHaveAttribute('value', '0');
  await page.clock.fastForward(9000);
  await expect(progress).toContainText('Page 3 /');
  await expect(meter).toHaveAttribute('value', '9000');
  await page.clock.fastForward(1000);
  await expect(progress).toContainText('Page 4 /');
  const match = fixture.snapshot.matches.find((item) => item.player1Id && item.player2Id)!;
  Object.assign(match, { status: 'playing', stationId: station.id });
  Object.assign(station, { currentMatchId: match.id, status: 'occupied' });
  await advanceUntilProgress(false);
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
  await advanceUntilProgress(true);
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

for (const [width, height] of [
  [1280, 720],
  [1920, 1080],
] as const)
  test(`${width}px recent results select the newest confirmed outcomes inside the source scope`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: width === 1280 ? 'dark' : 'light' });
    const { snapshot, responses, unexpected } = await mockEvent(page, { idle: true });
    const base = snapshot.matches.find(
      (match) => match.stage === 'group' && match.division === 'upper' && match.player2Id,
    )!;
    const result = (id: string, minute: number, facts: Partial<LiveMatch> = {}) => ({
      ...base,
      id,
      poolIndex: 0,
      status: 'complete',
      outcome: 'played',
      winnerId: base.player1Id,
      score1: 2,
      score2: 1,
      resultUpdatedAt: `2026-10-04T00:${String(minute).padStart(2, '0')}:00.000Z`,
      ...facts,
    });
    const played = result('new-played', 12, {
      player1Name: TEAM_ALIAS,
      player2Name: `Opponent · ${TEAM_ALIAS}`,
      player1Characters: ['mario'],
      player2Characters: width === 1280 ? ['steve'] : ['link'],
    });
    const forfeit = result('forfeit', 11, {
      outcome: 'forfeit',
      winnerId: base.player2Id!,
      score1: -1,
      score2: 0,
    });
    responses['eventOps.snapshot'] = {
      ...snapshot,
      nativeBrackets: [],
      matches: [
        result('outside-scope', 16, { poolIndex: 1 }),
        result('unconfirmed-draft', 15, {
          status: 'playing',
          stationId: snapshot.stations[1]!.id,
          score1: 7,
          score2: 5,
        }),
        result('invalid-winner', 14, { winnerId: 'not-an-entrant' }),
        result('newer-bye', 13, { outcome: 'bye', player2Id: null }),
        played,
        forfeit,
        result('older-played', 10),
      ],
    };
    await page.goto(
      `/overlay/${PLAN_ID}?station=${snapshot.stations[0]!.id}&pool=upper%3A0&controls=0`,
    );
    const progress = page.getByRole('region', { name: 'Tournament progress', exact: true });
    await expect(progress.getByRole('heading', { name: 'Recent results' })).toBeVisible();
    await expect(progress.getByText('Page 1 / 2', { exact: true })).toBeVisible();
    await expect(progress.locator('[data-match-id]')).toHaveCount(2);
    await expect(progress.locator('[data-match-id]').first()).toHaveAttribute(
      'data-match-id',
      played.id,
    );
    await expect(progress.locator('[data-match-id]').last()).toHaveAttribute(
      'data-match-id',
      forfeit.id,
    );
    const playedCard = progress.locator(`[data-match-id="${played.id}"]`);
    const forfeitCard = progress.locator(`[data-match-id="${forfeit.id}"]`);
    await expect(playedCard.getByLabel('Score 2', { exact: true })).toBeVisible();
    await expect(playedCard.getByLabel('Score 1', { exact: true })).toBeVisible();
    await expect(playedCard.locator('[data-winner]')).toContainText(TEAM_ALIAS);
    await expect(playedCard.locator('img')).toHaveCount(width === 1280 ? 1 : 2);
    await expect(
      progress.getByText('Profile mains · Fighter artwork', { exact: false }),
    ).toBeVisible();
    await expect(forfeitCard.getByText('Forfeit', { exact: true })).toBeVisible();
    await expect(forfeitCard.getByLabel(/^Score /)).toHaveCount(0);
    await fits(page);
    const firstScore = (await playedCard.getByLabel('Score 2', { exact: true }).boundingBox())!;
    const secondScore = (await playedCard.getByLabel('Score 1', { exact: true }).boundingBox())!;
    expect(Math.abs(firstScore.y - secondScore.y)).toBeLessThanOrEqual(1);
    expect(
      (await new AxeBuilder({ page }).include('.broadcast-intermission').analyze()).violations,
    ).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`intermission-recent-results-${width}.png`),
    });
    await page.keyboard.press('ArrowRight');
    await expect(progress.getByRole('heading', { name: /Pool A/ })).toBeVisible();
    await expect(progress.getByText('Page 2 / 2', { exact: true })).toBeVisible();
    expect(unexpected).toEqual([]);
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
  await expect(progress.getByText('Manual', { exact: true })).toBeVisible();
  await expect(progress.getByRole('progressbar', { name: 'Page rotation' })).toHaveCount(0);
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
  test(`${width}px cancelled Auto source keeps recorded results and stops showing an active set`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: (width * 9) / 16 });
    await page.emulateMedia({ colorScheme: theme });
    await page.clock.install({ time: new Date('2026-10-04T00:00:00Z') });
    const options = { idle: true, failure: false };
    const { snapshot, responses, unexpected } = await mockEvent(page, options);
    const [playing, played, pending] = bracketFixture(4, false);
    const station = snapshot.stations[0]!;
    Object.assign(playing!, { status: 'playing', stationId: station.id, score1: 7, score2: 5 });
    Object.assign(played!, {
      status: 'complete',
      outcome: 'played',
      score1: 2,
      score2: 1,
      winnerId: played!.player1Id,
    });
    const event = {
      ...snapshot,
      matches: [playing!, played!, pending!],
      nativeBrackets: [
        {
          id: 'rehearsal',
          division: 'upper',
          stage: 'main',
          entrantIds: Array.from({ length: 4 }, (_, index) => `entrant-${index}`),
          complete: false,
          winnerId: null,
          standings: [],
        },
      ],
    };
    responses['eventOps.snapshot'] = event;
    const overlay = (mode: string) =>
      `/overlay/${PLAN_ID}?station=${station.id}&presentation=${mode}&controls=0`;
    const progress = page.getByRole('region', { name: 'Tournament progress', exact: true });
    const capture = page.getByRole('region', { name: 'Transparent game capture area' });
    const current = page.getByLabel('Current match');

    await page.goto(overlay('auto'));
    await expect(capture).toBeVisible();
    await expect(current).toContainText(TEAM_ALIAS);
    await expect(progress).not.toBeVisible();
    event.plan.status = 'cancelled';
    await expect
      .poll(async () => {
        await page.clock.runFor(2000);
        return progress.isVisible();
      })
      .toBe(true);
    await expect(page).toHaveURL(/presentation=auto/);
    await expect(progress).toContainText('Event cancelled');
    await expect(capture).not.toBeVisible();
    const unfinished = progress.locator(`[data-match-id="${playing!.id}"]`);
    await expect(unfinished).toHaveAccessibleName(/No result recorded/);
    await expect(unfinished).not.toHaveClass(/is-playing/);
    await expect(unfinished.getByLabel(/Score [75]/)).toHaveCount(0);
    const recorded = progress.locator(`[data-match-id="${played!.id}"]`);
    await expect(recorded).toHaveAccessibleName(/Final result/);
    await expect(recorded.getByLabel('Score 2', { exact: true })).toBeVisible();
    await expect(recorded.locator('.is-winner')).toHaveCount(1);
    await expect(progress.locator(`[data-match-id="${pending!.id}"]`)).toHaveAccessibleName(
      /No result recorded/,
    );
    await fits(page);
    expect(
      (
        await new AxeBuilder({ page })
          .include('.broadcast-intermission')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`intermission-cancelled-native-${width}.png`),
    });

    options.failure = true;
    const interrupted = page.getByText('Connection interrupted · last received scores', {
      exact: true,
    });
    await expect
      .poll(async () => {
        await page.clock.runFor(2000);
        return interrupted.isVisible();
      })
      .toBe(true);
    await expect(unfinished).toBeVisible();
    await expect(recorded).toBeVisible();
    await expect(capture).not.toBeVisible();

    options.failure = false;
    await page.goto(overlay('gameplay'));
    await expect(capture).toBeVisible();
    await expect(progress).not.toBeVisible();
    await expect(page.locator('.broadcast-topline')).toContainText('EVENT CANCELLED');
    await expect(page.locator('.broadcast-topline')).toContainText('NO ACTIVE SET');
    await expect(current).toHaveCount(0);
    await expect(capture).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(page.locator('.broadcast-matchup')).not.toHaveCSS(
      'background-color',
      'rgba(0, 0, 0, 0)',
    );
    await page.screenshot({
      path: testInfo.outputPath(`intermission-cancelled-gameplay-${width}.png`),
    });
    await page.goto(overlay('progress'));
    await expect(unfinished).toHaveAccessibleName(/No result recorded/);

    // Older SQL-era events can store a no contest as a blocked match.
    Object.assign(playing!, {
      status: 'blocked',
      blockedReason: 'Both players withdrawn: no contest; no winner or score recorded',
      stationId: null,
      score1: null,
      score2: null,
    });
    await page.reload();
    await expect(unfinished).toHaveAccessibleName(/No contest/);
    await expect(unfinished).not.toHaveClass(/is-playing/);
    await expect(recorded.getByLabel('Score 2', { exact: true })).toBeVisible();
    await fits(page);
    await page.screenshot({
      path: testInfo.outputPath(`intermission-closed-native-no-contest-${width}.png`),
    });
    expect(unexpected).toEqual([]);
  });
}

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
    const noContest = linked('Withdrawal no contest', {
      status: 'blocked',
      blockedReason: 'Both players withdrawn: no contest; no winner or score recorded',
    });
    const lower = linked('Imported consolation set', {
      division: 'lower',
      stage: 'consolation',
    });
    const plan = { ...fixture.snapshot.plan, bracketMode: 'challonge' };
    fixture.responses['eventOps.snapshot'] = {
      ...fixture.snapshot,
      plan,
      nativeBrackets: [],
      matches: [pool, played, forfeit, bye, pending, noContest, lower],
      brackets: [
        { division: 'upper', stage: 'main', slug: 'linked-upper' },
        { division: 'lower', stage: 'consolation', slug: 'linked-lower' },
      ],
    };
    await page.goto(`/overlay/${PLAN_ID}?station=${station!.id}&presentation=auto&controls=0`);
    const progress = page.getByRole('region', { name: 'Tournament progress', exact: true });
    await expect(progress.getByRole('heading', { name: 'Recent results' })).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(progress.getByRole('heading', { name: /pool/i })).toBeVisible();
    await page.keyboard.press('ArrowRight');
    const upper = progress.getByRole('table', { name: 'Linked Upper Championship bracket' });
    await expect(progress).toContainText('Page 3 / 5');
    await expect(progress).not.toContainText(/Section \d+ \/ /);
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
    await expect(progress).toContainText('Page 4 / 5');
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
    await expect(progress.getByRole('heading', { name: 'Recent results' })).toBeVisible();
    await page.keyboard.press('ArrowLeft');
    await expect(lowerTable).toContainText('1–2');

    plan.status = 'complete';
    await page.clock.runFor(5000);
    await expect(progress).toContainText('Event complete');
    await expect(lowerTable).toContainText('1–2');
    await page.keyboard.press('ArrowLeft');
    await expect(upper.getByRole('row', { name: /Imported pending set/ })).toContainText(
      'No result recorded',
    );
    await expect(upper.getByRole('row', { name: /Withdrawal no contest/ })).toContainText(
      'No contest',
    );
    await expect(upper).not.toContainText('Awaiting opponent');
    await fits(page);
    await page.screenshot({ path: testInfo.outputPath(`intermission-closed-linked-${width}.png`) });
    await page.keyboard.press('ArrowLeft');
    await expect(upper.getByRole('row', { name: /Imported played set/ })).toContainText('2–0');
    await fits(page);
    await page.screenshot({
      path: testInfo.outputPath(`intermission-closed-linked-results-${width}.png`),
    });
    await page.keyboard.press('ArrowLeft');
    await expect(progress.getByRole('heading', { name: /Pool/ })).toBeVisible();
    await expect(progress.getByRole('columnheader', { name: 'No result' })).toBeVisible();
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
    const lastQualifier = pages.findLastIndex((item) => item.kind === 'qualification');
    const upperHeading = progress.getByRole('heading', {
      name: 'Upper Championship qualification',
    });
    const lowerHeading = progress.getByRole('heading', {
      name: 'Lower Championship qualification',
    });
    const seen = new Set<string>();
    for (let index = 0; index <= lastQualifier; index++) {
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
          await expect(progress).not.toContainText(/Section \d+ \/ /);
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
      if (index < lastQualifier) await page.keyboard.press('ArrowRight');
    }
    expect(seen.size).toBe(12);
    await expect(lowerHeading).toBeVisible();
    await expect(progress).toContainText('Under score review');

    // The next poll publishes one bracket while keeping the other field and its active page.
    const mixed = { ...snapshot, pendingFinals: fields.slice(1) };
    fixture.responses['eventOps.snapshot'] = mixed;
    const mixedPages = broadcastProgressPages(mixed);
    const lastMixedQualifier = mixedPages.findLastIndex((item) => item.kind === 'qualification');
    const lastPage = `Page ${lastMixedQualifier + 1} / ${mixedPages.length}`;
    await expect
      .poll(async () => {
        await page.clock.runFor(2000);
        return progress.getByText(lastPage, { exact: false }).isVisible();
      })
      .toBe(true);
    await expect(lowerHeading).toBeVisible();
    await expect(progress).not.toContainText(/Section \d+ \/ /);
    const firstDraw = mixedPages.findIndex((item) => item.kind === 'bracket');
    for (let i = lastMixedQualifier; i > firstDraw; i--) await page.keyboard.press('ArrowLeft');
    await expect(progress.locator('.event-bracket-match').first()).toBeVisible();
    await expect(upperHeading).toHaveCount(0);
    expect(fixture.unexpected).toEqual([]);
  });
}
