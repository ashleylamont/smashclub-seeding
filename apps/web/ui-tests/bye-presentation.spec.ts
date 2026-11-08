import { expect, test } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { mockEvent, PLAN_ID, PLAYER_NAME, ready } from './fixtures';
import { bracketFixture } from '../test/fixtures/brackets';
import { chooseOption } from '../test-support/controls';

test('TO contestant rows use actual participant IDs rather than TBD placeholders', async ({
  page,
}) => {
  const fixture = await mockEvent(page, { role: 'admin', bracket: true });
  const bye = fixture.overview.matches.find((match) => match.outcome === 'bye')!;
  Object.assign(bye, { player2Id: null, player2Name: 'TBD' });
  await page.goto(`/operate/${PLAN_ID}`);
  await chooseOption(page.getByRole('combobox', { name: 'View', exact: true }), 'all');
  const card = page.locator('article.ops-match').filter({ hasText: bye.label });
  await expect(card).toContainText('advanced automatically');
  await expect(card.locator('.ops-contestant').nth(1)).toContainText('Bye');
  await expect(card).not.toContainText('TBD');
  Object.assign(bye, {
    player1Id: null,
    player1Name: 'TBD',
    player2Id: 'fixture-bea',
    player2Name: 'Bea',
    status: 'blocked',
    outcome: null,
    winnerId: null,
  });
  await expect(card.locator('.ops-contestant').nth(0)).toContainText('Awaiting opponent');
  await expect(card.locator('.ops-contestant').nth(1)).toContainText('Bea');
  await expect(card).not.toContainText('TBD');
  expect(fixture.unexpected).toEqual([]);
});

for (const adapter of ['signed-in', 'guest'] as const)
  test(`${adapter} completed native byes never look like played scores or pending opponents`, async ({
    page,
  }, testInfo) => {
    const fixture = await mockEvent(page, { role: 'player', bracket: true });
    const base = fixture.snapshot.matches.find((match) => match.nativeBracketId)!;
    const generated = bracketFixture(5, false);
    const sourceBye = generated.find((match) => match.outcome === 'bye')!;
    // Actual native projections use a nonempty placeholder for missing IDs.
    const bye = {
      ...sourceBye,
      player1Name: sourceBye.player1Id ? sourceBye.player1Name : 'TBD',
      player2Name: sourceBye.player2Id ? sourceBye.player2Name : 'TBD',
    };
    // Reproduce a later automatic resolution with a recorded feeder and real winner identity.
    const propagated = {
      ...bye,
      id: 'propagated-bye',
      label: 'Propagated bye',
      parent1MatchId: bye.id,
      nativeRound: 2,
    };
    const pending = {
      ...bye,
      id: 'pending-feed',
      label: 'Pending feeder',
      status: 'blocked',
      outcome: null,
      winnerId: null,
      parent2MatchId: 'unfinished-feed',
    };
    const forfeit = {
      ...bye,
      id: 'forfeit',
      label: 'Forfeit result',
      outcome: 'forfeit',
      player2Id: 'opponent',
      player2Name: 'Opponent',
      score1: 99,
      score2: 0,
    };
    const noContest = {
      ...forfeit,
      id: 'no-contest',
      label: 'No contest result',
      status: 'blocked',
      outcome: null,
      winnerId: null,
      blockedReason: 'Both players withdrawn: no contest; no winner or score recorded',
    };
    fixture.snapshot.matches = [bye, propagated, pending, forfeit, noContest].map((match) =>
      Object.assign({ ...base }, match),
    );
    fixture.snapshot.stationQueues.length = 0;
    fixture.snapshot.poolRounds.length = 0;
    if (adapter === 'guest') {
      fixture.snapshot.settings.playerReports = false;
      fixture.responses['eventOps.guests.redeem'] = {
        sessionToken: 'fixture-venue-pass'.repeat(3),
        expiresAt: null,
      };
      fixture.responses['eventOps.guests.matches'] = { ...fixture.snapshot, reports: [] };
    }
    await page.goto(
      `/play/${PLAN_ID}?player=${bye.winnerId}${adapter === 'guest' ? '#token=fixture-invitation' : ''}`,
    );
    for (const label of [bye.label, propagated.label]) {
      const card = page.locator('article.ops-match').filter({ hasText: label });
      await expect(card).toContainText('Bye');
      await expect(card).toContainText('advanced automatically');
      await expect(card).toContainText('Next: Pending feeder');
      await expect(card).not.toContainText('TBD');
      await expect(card.getByRole('heading')).not.toContainText(' vs ');
      await expect(card.getByRole('spinbutton')).toHaveCount(0);
      await expect(card.getByRole('button')).toHaveCount(0);
      await expect(card).not.toContainText('Confirmed result:');
    }
    const pendingCard = page
      .locator('article.ops-match')
      .filter({ has: page.locator('.ops-match-meta').filter({ hasText: pending.label }) });
    await expect(pendingCard).toContainText('Awaiting opponent');
    await expect(pendingCard).not.toContainText('Bye');
    await expect(pendingCard.getByRole('spinbutton')).toHaveCount(0);
    const forfeitCard = page.locator('article.ops-match').filter({ hasText: forfeit.label });
    await expect(forfeitCard).toContainText('Opponent forfeits');
    await expect(forfeitCard).not.toContainText('99');
    await expect(forfeitCard.getByRole('button')).toHaveCount(0);
    const noContestCard = page.locator('article.ops-match').filter({ hasText: noContest.label });
    await expect(noContestCard).toContainText('No contest');
    await expect(noContestCard).not.toContainText('99');
    await expect(noContestCard.getByRole('button')).toHaveCount(0);
    const results = page.locator('#event-results');
    await expect(results).toContainText('advanced automatically');
    await expect(results).not.toContainText('To be decided');
    await expect(results).not.toContainText('TBD');
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
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
        path: testInfo.outputPath(`bye-${adapter}-${viewport.width}.png`),
        fullPage: true,
      });
    }
    expect(fixture.submissions).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });

for (const theme of ['dark', 'light'] as const) {
  for (const width of [390, 1440]) {
    test(`imported byes show only recorded advancement at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const fixture = await mockEvent(page);
      const source = fixture.snapshot.matches.find((match) => match.status === 'complete')!;
      Object.assign(fixture.snapshot.plan, { bracketMode: 'challonge', liveOwned: false });
      Object.assign(fixture.snapshot, {
        brackets: [{ division: source.division, stage: 'main', slug: 'linked-finals' }],
      });
      const missing = {
        ...source,
        id: 'imported-bye-missing',
        sourceSetId: 'linked-set-a',
        sourceKey: 'set:linked-set-a',
        stage: 'main',
        poolIndex: null,
        label: 'Imported bye without a winner',
        status: 'complete',
        outcome: 'bye',
        player1Name: PLAYER_NAME,
        player2Id: null,
        player2Name: 'TBD',
        winnerId: null,
        score1: null,
        score2: null,
        syncState: 'synced',
        stationId: null,
        resultUpdatedAt: '2026-10-04T00:00:01Z',
      };
      const named = {
        ...missing,
        id: 'imported-bye-named',
        sourceSetId: 'linked-set-b',
        sourceKey: 'set:linked-set-b',
        label: 'Imported bye with a winner',
        player1Id: source.player2Id,
        player1Name: source.player2Name,
        winnerId: source.player2Id,
        resultUpdatedAt: '2026-10-04T00:00:02Z',
      };
      const mismatched = {
        ...missing,
        id: 'imported-bye-mismatched',
        sourceSetId: 'linked-set-c',
        sourceKey: 'set:linked-set-c',
        label: 'Imported bye with an unrelated winner ID',
        winnerId: named.winnerId,
        resultUpdatedAt: '2026-10-04T00:00:03Z',
      };
      Object.assign(fixture.snapshot, { matches: [missing, named, mismatched] });
      fixture.snapshot.placements = [];
      fixture.snapshot.stationQueues = [];
      fixture.snapshot.poolRounds = [];

      await page.goto(`/play/${PLAN_ID}`);
      await chooseOption(page.getByRole('combobox', { name: 'Match view' }), 'results');
      const neutral = 'Bye recorded. No advancing entrant identified.';
      const results = page.getByRole('region', { name: 'Results', exact: true });
      for (const match of [missing, mismatched]) {
        const card = page.locator('article.ops-match').filter({ hasText: match.label });
        await expect(card.getByRole('heading', { name: 'Bye', exact: true })).toBeVisible();
        await expect(card).toContainText(neutral);
        await expect(card).not.toContainText(/TBD|advanced automatically|Next:/);
        await expect(card.getByRole('button')).toHaveCount(0);
        await expect(card.getByRole('spinbutton')).toHaveCount(0);
        const recorded = results.getByRole('article').filter({ hasText: match.label });
        await expect(recorded).toContainText(PLAYER_NAME);
        await expect(recorded).toContainText(neutral);
        await expect(recorded.locator('.is-winner')).toHaveCount(0);
      }
      const known = results.getByRole('article').filter({ hasText: named.label });
      await expect(known).toContainText(`${named.player1Name} advanced automatically.`);
      await expect(known.locator('.is-winner')).toHaveCount(1);
      await page.evaluate(() => scrollTo(0, 0));
      await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
      await page.mouse.move(0, 0);
      await ready(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
          .violations,
      ).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath('public-imported-byes.png'),
        fullPage: true,
      });

      const resultsLink = page
        .getByRole('navigation', { name: 'Event sections' })
        .getByRole('link', { name: 'Results', exact: true });
      await resultsLink.focus();
      await expect(resultsLink).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(`/play/${PLAN_ID}#event-results`);

      await page.setViewportSize(
        width === 390 ? { width: 1280, height: 720 } : { width: 1920, height: 1080 },
      );
      await page.clock.install({ time: new Date('2026-10-04T00:00:00Z') });
      Object.assign(fixture.snapshot, { matches: [missing, named] });
      await page.goto(`/overlay/${PLAN_ID}?controls=0`);
      const rail = page.getByRole('region', { name: 'Recent resolved sets' });
      const namedCard = rail.locator(`[data-match-id="${named.id}"]`);
      await expect(namedCard).toContainText('Advanced automatically · Bye');
      await expect(namedCard.locator('.is-winner')).toContainText(named.player1Name!);
      await expect(rail.locator(`[data-match-id="${missing.id}"]`)).toHaveCount(0);

      Object.assign(fixture.snapshot, { matches: [missing, named, mismatched] });
      await page.clock.runFor(5100);
      const invalidCard = rail.locator(`[data-match-id="${mismatched.id}"]`);
      await expect(invalidCard).toHaveAttribute('aria-label', /Bye recorded$/);
      await expect(invalidCard.getByText(neutral, { exact: true })).toBeVisible();
      await expect(invalidCard).not.toContainText(/TBD|Advanced automatically/);
      await expect(invalidCard.locator('.is-winner, b')).toHaveCount(0);
      await expect(page.getByLabel('Recent match outcomes')).toContainText('Bye recorded');
      await expect(page.getByTestId('broadcast-result-notice')).toHaveCount(0);
      await ready(page);
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
        path: testInfo.outputPath('obs-imported-byes.png'),
        omitBackground: true,
      });
      await page.goto(`/overlay/${PLAN_ID}?controls=0&presentation=progress`);
      const linked = page.getByRole('table', { name: /Linked .* Championship bracket/i });
      for (const match of [missing, mismatched]) {
        const row = linked.getByRole('row').filter({ hasText: match.label });
        await expect(row.getByRole('cell', { name: 'Bye', exact: true })).toBeVisible();
        await expect(row).toContainText(PLAYER_NAME);
        await expect(row.getByText(/· Winner/)).toHaveCount(0);
        await expect(row).not.toContainText('TBD');
      }
      await expect(
        linked
          .getByRole('row')
          .filter({ hasText: named.label })
          .getByRole('cell', { name: `${named.player1Name} · Winner` }),
      ).toBeVisible();
      await ready(page);
      await page.screenshot({
        path: testInfo.outputPath('obs-linked-bye-progress.png'),
        omitBackground: true,
      });
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.submissions).toEqual([]);
    });
  }
}
