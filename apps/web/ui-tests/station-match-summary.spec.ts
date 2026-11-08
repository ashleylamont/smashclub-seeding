import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mockEvent, PLAN_ID, ready } from './fixtures';

async function capture(page: Page, selector: string, path: string) {
  // Use the same settled page position for contrast analysis and the capture.
  await page.evaluate(() => scrollTo(0, 0));
  await ready(page);
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    (
      await new AxeBuilder({ page })
        .include(selector)
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.screenshot({ path, fullPage: true });
}

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test(`${theme} ${width}px stations and pool rounds show the actual match state`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const { overview, snapshot, unexpected } = await mockEvent(page, { role: 'admin' });
      const match = snapshot.matches.find((item) => item.status === 'playing')!;
      const station = snapshot.stations.find(({ id }) => id === match.stationId)!;
      const alias = 'Alexandria with a long tournament alias from Western Sydney';
      const entrant = snapshot.entrants.find(({ id }) => id === match.player1Id)!;
      entrant.name = alias;
      for (const row of snapshot.matches) {
        if (row.player1Id === entrant.id) row.player1Name = alias;
        if (row.player2Id === entrant.id) row.player2Name = alias;
      }
      Object.assign(match, { started: true, called: false });
      await page.goto(`/operate/${PLAN_ID}`);
      const run = page.getByRole('tabpanel', { name: 'Run matches' });
      const tile = run.locator('.ops-station-tile').filter({ hasText: station.name });
      const stationScore = tile.locator('b');
      await expect(tile).toHaveClass(/is-playing/);
      await expect(tile.getByText('Playing now', { exact: true })).toBeVisible();
      await expect(tile).toContainText(alias);
      await expect(stationScore).toHaveText('vs');
      const openScore = tile.getByRole('button', { name: 'Score match', exact: true });
      await openScore.press('Enter');
      await expect(run.locator('#match-desk')).toBeFocused();
      await expect(run.getByRole('button', { name: 'Update live score' })).toBeEnabled();
      await capture(page, '.ops-page', testInfo.outputPath('to-station-unscored.png'));

      const playerUrl = `/play/${PLAN_ID}?player=${match.player1Id}#what-next`;
      await page.goto(playerUrl);
      const next = page.getByRole('region', { name: 'What next' });
      // Let the deep link finish scrolling before capture resets the viewport.
      await expect(next).toBeInViewport();
      const playerStation = next
        .getByRole('article')
        .filter({ has: page.getByRole('heading', { name: station.name, exact: true }) });
      const playerScore = playerStation.locator('.pool-flow-current > b');
      await expect(playerStation.getByText('Playing now', { exact: true })).toBeVisible();
      await expect(playerScore).toHaveText('vs');
      await expect(playerStation.getByRole('button', { name: 'Report this result' })).toBeEnabled();
      await capture(page, '.player-event-hub', testInfo.outputPath('player-station-unscored.png'));

      Object.assign(match, { score1: 0, score2: 0, liveScore1: 0, liveScore2: 0 });
      await page.reload();
      await expect(playerScore).toHaveText('0 – 0');
      await page.goto(`/operate/${PLAN_ID}`);
      await expect(stationScore).toHaveText('0–0');

      Object.assign(match, {
        started: false,
        called: true,
        score1: null,
        score2: null,
        liveScore1: null,
        liveScore2: null,
      });
      const shared = { active: 0, capacity: 1, overCapacity: 0 };
      Object.assign(snapshot, { sharedDispatch: shared, stationQueues: [] });
      Object.assign(overview, { sharedDispatch: shared, stationQueues: [] });
      await page.goto(playerUrl);
      await expect(next).toBeInViewport();
      const calls = next.getByRole('region', { name: 'Match calls' });
      const rounds = next.locator('.pool-flow-rounds');
      const disclosure = rounds.getByRole('button', { name: /Upper Pool A.*rounds/i });
      const roundRow = rounds.getByRole('listitem').filter({ hasText: alias }).filter({
        hasText: match.player2Name!,
      });
      await expect(calls.getByText(`Called · ${station.name}`, { exact: true })).toBeVisible();
      await disclosure.press('Enter');
      await expect(disclosure).toBeFocused();
      await expect(roundRow.getByText('Called', { exact: true })).toBeVisible();
      await expect(roundRow.getByText('Playing now', { exact: true })).toHaveCount(0);
      await capture(page, '.player-event-hub', testInfo.outputPath('player-round-called.png'));

      Object.assign(match, { called: false, started: true });
      await page.reload();
      await disclosure.press('Enter');
      await expect(roundRow.getByText('Playing now', { exact: true })).toBeVisible();
      Object.assign(match, {
        status: 'complete',
        outcome: 'played',
        winnerId: match.player1Id,
        score1: 2,
        score2: 1,
      });
      await page.reload();
      await disclosure.press('Enter');
      await expect(roundRow.getByText('2–1 · complete', { exact: true })).toBeVisible();
      expect(unexpected).toEqual([]);
    });

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test(`${theme} ${width}px pool schedule describes the frozen format for actual single and repeated meetings`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const { snapshot, unexpected } = await mockEvent(page);
      const plan = Object.assign(snapshot.plan, { structureOptions: { roundRobinMeetings: 1 } });
      const pool = snapshot.poolRounds.find(({ poolKey }) => poolKey === 'upper:0')!;
      const first = snapshot.matches.find(({ id }) => id === pool.rounds[0]!.matchIds[0])!;
      const alias = 'Alexandria with a long tournament alias from Western Sydney';
      snapshot.entrants.find(({ id }) => id === first.player1Id)!.name = alias;
      for (const match of snapshot.matches) {
        if (match.player1Id === first.player1Id) match.player1Name = alias;
        if (match.player2Id === first.player1Id) match.player2Name = alias;
      }
      const url = `/play/${PLAN_ID}?pool=upper%3A0#what-next`;
      const schedule = page.locator('.pool-flow-rounds');
      const format = schedule.getByText(/^Draw format/);
      const pairing = schedule.getByRole('listitem').filter({ hasText: alias }).filter({
        hasText: first.player2Name!,
      });
      const openSchedule = async (rounds: number) => {
        const disclosure = schedule.getByRole('button', { name: new RegExp(`${rounds} rounds`) });
        await disclosure.press('Enter');
        await expect(disclosure).toBeFocused();
        await expect(schedule.getByRole('heading', { name: /^Round \d+$/ })).toHaveCount(rounds);
        const firstRound = schedule.getByRole('heading', { name: 'Round 1', exact: true });
        await firstRound.scrollIntoViewIfNeeded();
        await expect(firstRound).toBeInViewport();
      };

      await page.goto(url);
      await expect(format).toHaveText('Draw format · 1 meeting per pairing');
      await openSchedule(5);
      await expect(pairing).toHaveCount(1);
      await capture(page, '.player-event-hub', testInfo.outputPath('one-meeting.png'));

      // The next leg uses new match IDs and later rounds, like a generated repeat.
      for (const round of pool.rounds.slice()) {
        const matchIds = round.matchIds.map((id) => {
          const original = snapshot.matches.find((match) => match.id === id)!;
          const repeated = { ...original, id: `second-${id}` };
          snapshot.matches.push(repeated);
          return repeated.id;
        });
        pool.rounds.push({ ...round, round: round.round + 5, matchIds });
      }
      plan.structureOptions.roundRobinMeetings = 2;
      await page.reload();
      await expect(format).toHaveText('Draw format · 2 meetings per pairing');
      await openSchedule(10);
      await expect(pairing).toHaveCount(2);
      await capture(page, '.player-event-hub', testInfo.outputPath('two-meetings.png'));

      if (width === 390) {
        // SQL always serializes its default, even when imported pairings repeat.
        Object.assign(plan, {
          bracketMode: 'challonge',
          liveOwned: false,
          structureOptions: { roundRobinMeetings: 1 },
        });
        await page.reload();
        await openSchedule(10);
        await expect(format).toHaveCount(0);
        await expect(pairing).toHaveCount(2);
        await capture(page, '.player-event-hub', testInfo.outputPath('linked-schedule.png'));
      } else {
        Object.assign(plan, { structureOptions: undefined, status: 'complete' });
        await page.reload();
        await page
          .getByRole('button', { name: 'Pool schedule history', exact: true })
          .press('Enter');
        await openSchedule(10);
        await expect(format).toHaveCount(0);
        await expect(pairing).toHaveCount(2);
        await capture(page, '.player-event-hub', testInfo.outputPath('old-archived-schedule.png'));
      }
      expect(unexpected).toEqual([]);
    });
