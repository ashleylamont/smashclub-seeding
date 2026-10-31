import { expect, test } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { mockEvent, PLAN_ID, ready } from './fixtures';
import { chooseOption } from '../test-support/controls';

for (const width of [390, 1440])
  test(`${width}px focused player follows published finals while other pools remain active, then restores Everyone`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockEvent(page, { bracket: true, role: 'player' });
    const player = fixture.snapshot.nativeBrackets[0]!.entrantIds[0]!;
    const ownPool = fixture.snapshot.matches.find(
      (match) =>
        match.stage === 'group' && (match.player1Id === player || match.player2Id === player),
    )!;
    for (const match of fixture.snapshot.matches)
      if (
        match.stage === 'group' &&
        match.division === ownPool.division &&
        match.poolIndex === ownPool.poolIndex
      )
        Object.assign(match, {
          status: 'complete',
          score1: 2,
          score2: 0,
          winnerId: match.player1Id,
        });
    const completed = new Set(
      fixture.snapshot.matches
        .filter((match) => match.status === 'complete')
        .map((match) => match.id),
    );
    for (const queue of fixture.snapshot.stationQueues) {
      if (queue.currentMatchId && completed.has(queue.currentMatchId)) queue.currentMatchId = null;
      if (queue.nextMatchId && completed.has(queue.nextMatchId)) queue.nextMatchId = null;
      queue.upcoming = queue.upcoming.filter((item) => !completed.has(item.matchId));
    }
    for (const station of fixture.snapshot.stations)
      if (station.currentMatchId && completed.has(station.currentMatchId))
        Object.assign(station, { currentMatchId: null, status: 'free' });
    const otherPool = fixture.snapshot.matches.find(
      (match) => match.stage === 'group' && match.poolIndex !== ownPool.poolIndex,
    )!;
    otherPool.status = 'ready';
    await page.goto(
      `/play/${PLAN_ID}?player=${player}&pool=${ownPool.division}%3A${ownPool.poolIndex}`,
    );
    await expect(page.getByLabel('Show matches for')).toHaveAttribute('data-value', player);
    await expect(page.getByText('Your pool sets are recorded.', { exact: false })).toContainText(
      'Other pool sets are still in progress',
    );
    const sectionOrder = () =>
      page
        .locator('.player-event-board-section')
        .evaluateAll((sections) => sections.map((section) => section.id));
    expect(await sectionOrder()).toEqual(['event-brackets', 'event-pools', 'event-results']);
    const nav = page.getByRole('navigation', { name: 'Event sections' });
    await expect(nav.getByRole('link')).toHaveText([
      'Find my matches',
      'What next',
      'Brackets',
      'Pools',
      'Results',
    ]);
    await expect(page.locator('#event-pools .event-pool')).toHaveCount(1);
    await expect(page.getByRole('heading', { name: 'Your bracket path' })).toBeVisible();
    await expect(page.locator('.player-bracket-path')).toContainText('Championship final');
    await expect(page.locator('.player-bracket-path li > strong')).not.toContainText([
      'Semi-final B',
    ]);
    await expect(page.locator('#event-brackets .event-bracket-match:visible')).toHaveCount(0);
    await page.getByRole('button', { name: 'Full draw & bracket standings' }).click();
    await expect(page.locator('#event-brackets .event-bracket-match')).toHaveCount(3);
    await expect(page.locator('#event-brackets')).toContainText('Winner of Semi-final B');
    await page.getByRole('button', { name: 'Full draw & bracket standings' }).click();
    // Pool context survives, but the selected player's assigned finals still appear.
    await expect(
      page.locator('article.ops-match').filter({ hasText: 'Championship final' }),
    ).toBeVisible();
    await expect(page.getByLabel('Your pool')).toHaveAttribute(
      'data-value',
      `${ownPool.division}:${ownPool.poolIndex}`,
    );
    await ready(page);
    expect(
      (
        await new AxeBuilder({ page })
          .include('.player-event-hub')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath(`focused-finals-${width}.png`),
      fullPage: true,
    });
    await page.reload();
    await expect(page.getByLabel('Show matches for')).toHaveAttribute('data-value', player);
    await chooseOption(page.getByLabel('Show matches for'), '');
    await expect(page.getByLabel('Your pool')).toHaveAttribute('data-value', '');
    await expect(page.locator('#event-pools .event-pool')).toHaveCount(
      new Set(
        fixture.snapshot.matches
          .filter((match) => match.stage === 'group')
          .map((match) => `${match.division}:${match.poolIndex}`),
      ).size,
    );
    await expect(page.locator('#event-brackets .event-bracket-match')).toHaveCount(3);
    await page.reload();
    await expect(page.getByLabel('Show matches for')).toHaveAttribute('data-value', '');
    expect(fixture.unexpected).toEqual([]);
  });

test('stored doubles member focuses the public team, and closed events retain history without a next-match call', async ({
  page,
}) => {
  const fixture = await mockEvent(page, { bracket: true });
  const team = fixture.snapshot.nativeBrackets[0]!.entrantIds[0]!;
  for (const match of fixture.snapshot.matches) {
    if (match.player1Id === team)
      Object.assign(match, { player1MemberIds: ['member-one', 'member-two'] });
    if (match.player2Id === team)
      Object.assign(match, { player2MemberIds: ['member-one', 'member-two'] });
  }
  Object.assign(
    fixture.snapshot.entrants.find((entrant) => entrant.id === team)!,
    { memberPlayerIds: ['member-one', 'member-two'] },
  );
  Object.assign(fixture.snapshot.plan, { status: 'cancelled' });
  await page.addInitScript(
    ({ planId }) => localStorage.setItem(`nemesis:player-filter:${planId}`, 'member-one'),
    { planId: PLAN_ID },
  );
  await page.goto(`/play/${PLAN_ID}`);
  await expect(page.getByLabel('Show matches for')).toHaveAttribute('data-value', team);
  await expect(page.getByRole('complementary', { name: 'Your progress' })).toContainText(
    'This event is closed',
  );
  await expect(page.getByRole('button', { name: 'Find next match' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Schedule & station history' })).toBeVisible();
  await expect(page.locator('article.ops-match input')).toHaveCount(0);
  await expect(page.locator('.player-event-board-section').first()).toHaveAttribute(
    'id',
    'event-brackets',
  );
  expect(fixture.unexpected).toEqual([]);
});
