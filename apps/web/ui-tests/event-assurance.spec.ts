import { expect, test } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { mockEvent, PLAN_ID, PLAYER_NAME, ready } from './fixtures';

async function accessible(page: Parameters<typeof mockEvent>[0]) {
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
}

test('light populated sixteen-slot bracket retains all rounds, byes and unresolved paths', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  const fixture = await mockEvent(page, { bracket: true });
  const base = fixture.snapshot.matches.find((match) => match.nativeBracketId)!;
  fixture.snapshot.matches = fixture.snapshot.matches.filter((match) => !match.nativeBracketId);
  for (let round = 1; round <= 4; round++)
    for (let slot = 0; slot < 2 ** (4 - round); slot++) {
      fixture.snapshot.matches.push(
        Object.assign(
          { ...base },
          {
            id: `wide-r${round}-${slot}`,
            label: `Round ${round} match ${slot + 1}`,
            nativeRound: round,
            nativeSlot: slot,
            player1Id: round === 1 ? `fixture-${slot * 2}` : null,
            player2Id: round === 1 && slot !== 0 ? `fixture-${slot * 2 + 1}` : null,
            player1Name:
              round === 1
                ? slot === 1
                  ? PLAYER_NAME
                  : `Wide bracket player ${slot * 2 + 1}`
                : null,
            player2Name: round === 1 && slot !== 0 ? `Wide bracket player ${slot * 2 + 2}` : null,
            parent1MatchId: round > 1 ? `wide-r${round - 1}-${slot * 2}` : null,
            parent2MatchId: round > 1 ? `wide-r${round - 1}-${slot * 2 + 1}` : null,
            winnerId: slot === 0 && round === 1 ? 'fixture-0' : null,
            score1: null,
            score2: null,
            outcome: round === 1 && slot === 0 ? 'bye' : null,
            status: round === 1 ? (slot === 0 ? 'complete' : 'ready') : 'blocked',
          },
        ),
      );
    }
  await page.goto(`/live/${PLAN_ID}`);
  const brackets = page.locator('.event-brackets');
  await expect(brackets.getByRole('heading', { name: 'Round 2', exact: true })).toBeVisible();
  await expect(brackets).toContainText('Winner of Round 3 match 2');
  await expect(brackets).toContainText('Round 1 match 1 · Bye');
  await expect(brackets).toContainText(PLAYER_NAME);
  await ready(page);
  await accessible(page);
  await expect(brackets.locator('.event-bracket').first()).toHaveScreenshot(
    'wide-bracket-light.png',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await accessible(page);
  await expect(brackets.locator('.event-bracket').first()).toHaveScreenshot(
    'wide-bracket-light-phone.png',
  );
  const rounds = brackets.locator('.event-bracket-rounds').first();
  await rounds.focus();
  await expect(rounds).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => rounds.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
  await rounds.evaluate((node) => {
    node.scrollLeft = node.scrollWidth;
  });
  const final = rounds.locator('.event-bracket-round').last().locator('.event-bracket-match');
  await final.scrollIntoViewIfNeeded();
  await expect(final).toBeInViewport({ ratio: 1 });

  expect(fixture.unexpected).toEqual([]);
});

test('busy light TO desk keeps pending disputes readable and keyboard destinations reachable', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  const fixture = await mockEvent(page, { role: 'admin' });
  fixture.overview.reports.forEach((report, index) => {
    report.status = 'pending';
    report.isDispute = index % 2 === 0;
    report.reporterLabel = `Synthetic reporter ${index + 1}`;
  });
  await page.goto(`/operate/${PLAN_ID}`);
  await expect(page.locator('.ops-report')).toHaveCount(fixture.overview.reports.length);
  await ready(page);
  await accessible(page);
  await expect(page).toHaveScreenshot('busy-to-light.png');
  const tab = page.getByRole('tab', { name: 'Run matches', exact: true });
  await tab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Players', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Standings / draw', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tabpanel', { name: 'Standings / draw', exact: true })).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
});

test('phone next-match start preserves revision and opens the reporting card', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await mockEvent(page, { role: 'player' });
  const queue = fixture.snapshot.stationQueues[0]!;
  const next = fixture.snapshot.matches.find((match) => match.id === queue.nextMatchId)!;
  const revision = next.revision;
  // The fixture's empty schedule list is inferred as never[]; add through its mutable JSON representation.
  Object.assign(fixture.snapshot, {
    poolSchedules: [
      {
        division: next.division,
        poolIndex: next.poolIndex,
        active: true,
        stationIds: [queue.stationId],
        selfRun: true,
        autoAcceptScores: true,
      },
    ],
  });
  await page.goto(`/play/${PLAN_ID}`);
  const start = page.getByRole('button', { name: 'We’re here — start match' });
  await expect(start).toBeEnabled();
  await start.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => fixture.starts.length).toBe(1);
  expect(fixture.starts[0]).toMatchObject({
    planId: PLAN_ID,
    matchId: next.id,
    stationId: queue.stationId,
    expectedRevision: revision,
  });
  const card = page.locator('article.ops-match').filter({ hasText: next.label });
  await expect(card).toHaveCount(1);
  await expect(card).toContainText(next.player1Name!);
  await ready(page);
  await accessible(page);
  await expect(page).toHaveScreenshot('next-match-phone.png');
  expect(fixture.unexpected).toEqual([]);
});

test('loading and empty phone states stay accessible without inventing match controls', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let release!: () => void;
  const fixture = await mockEvent(page, {
    role: 'player',
    loading: new Promise<void>((resolve) => {
      release = resolve;
    }),
  });
  fixture.snapshot.matches.length = 0;
  fixture.snapshot.stationQueues.length = 0;
  fixture.snapshot.poolRounds.length = 0;
  await page.goto(`/play/${PLAN_ID}`);
  await expect(page.getByRole('status')).toContainText('Loading your event');
  release();
  await expect(page.getByText('No matches in this view yet.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: /Submit score|start match/ })).toHaveCount(0);
  await ready(page);
  await accessible(page);
  await expect(page).toHaveScreenshot('empty-player-phone.png');
  expect(fixture.unexpected).toEqual([]);
});

for (const idle of [false, true])
  test(`720p OBS ${idle ? 'idle' : 'active'} preserves title and capture transparency`, async ({
    page,
  }) => {
    const fixture = await mockEvent(page, { idle });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`/overlay/${PLAN_ID}`);
    const aperture = page.getByLabel('Transparent game capture area');
    await expect(aperture).toBeVisible();
    await expect(page.getByRole('img', { name: 'Scan to report a match score' })).toHaveCount(0);
    const box = (await aperture.boundingBox())!;
    expect(box.width).toBeGreaterThan(600);
    expect(box.height).toBeGreaterThan(300);
    expect(
      await page.evaluate(
        ({ x, y }) =>
          document
            .elementsFromPoint(x, y)
            .filter(
              (element) =>
                !['rgba(0, 0, 0, 0)', 'transparent'].includes(
                  getComputedStyle(element).backgroundColor,
                ),
            ).length,
        { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      ),
    ).toBe(0);
    await ready(page);
    await expect(page).toHaveScreenshot(`overlay-720-${idle ? 'idle' : 'active'}.png`, {
      omitBackground: true,
    });
    expect(fixture.unexpected).toEqual([]);
  });
