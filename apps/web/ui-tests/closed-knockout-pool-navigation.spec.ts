import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mockEvent, PLAN_ID, PLAYER_NAME, ready } from './fixtures';

for (const theme of ['dark', 'light'] as const) {
  for (const width of [390, 1440]) {
    test(`a finished standalone knockout only links to available history at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);

      const { snapshot } = await mockEvent(page, { idle: true, bracket: true });
      const matches = snapshot.matches.filter((match) => match.nativeBracketId);
      const first = matches.find(({ id }) => id === 'fixture-semi-a')!;
      const second = matches.find(({ id }) => id === 'fixture-semi-b')!;
      const final = matches.find(({ id }) => id === 'fixture-final')!;
      const winnerId = first.player1Id!;
      const runnerUpId = second.player1Id!;
      snapshot.entrants.find(({ id }) => id === winnerId)!.name = PLAYER_NAME;
      Object.assign(second, { status: 'complete', outcome: 'bye', winnerId: runnerUpId });
      Object.assign(final, {
        status: 'complete',
        outcome: 'played',
        player1Name: PLAYER_NAME,
        player2Id: runnerUpId,
        player2Name: second.player1Name,
        score1: 2,
        score2: 0,
        winnerId,
      });
      Object.assign(snapshot.nativeBrackets[0]!, {
        complete: true,
        winnerId,
        standings: [
          { playerId: winnerId, place: 1 },
          { playerId: runnerUpId, place: 2 },
        ],
      });
      Object.assign(snapshot.plan, { structure: 'single_elimination', status: 'complete' });
      Object.assign(snapshot, {
        matches,
        brackets: [],
        poolRounds: [],
        placements: [],
        prizes: [],
      });

      await page.goto(`/play/${PLAN_ID}?player=${winnerId}`);
      const navigation = page.getByRole('navigation', { name: 'Event sections' });
      await expect(navigation.getByRole('link', { name: 'Find my matches' })).toBeVisible();
      await expect(
        navigation.getByRole('link', { name: 'Pool schedule', exact: true }),
      ).toHaveCount(0);
      await expect(navigation.getByRole('link', { name: 'Pools', exact: true })).toHaveCount(0);
      await expect(page.locator('#what-next, #event-pools')).toHaveCount(0);

      const history = page.getByRole('region', { name: 'Match history', exact: true });
      await expect(history).toContainText('Confirmed result: 2 – 0');
      await expect(history.getByRole('spinbutton')).toHaveCount(0);
      await history.getByRole('button', { name: 'Match filters' }).press('Enter');
      await expect(
        history.getByText('The pool filter refines standings and schedule history.'),
      ).toHaveCount(0);
      await expect(page.getByLabel('Show matches for')).toHaveAttribute('data-value', winnerId);
      await navigation.getByRole('link', { name: 'Brackets', exact: true }).press('Enter');
      await expect(page).toHaveURL(/#event-brackets$/);
      const brackets = page.getByRole('region', { name: 'Brackets', exact: true });
      await expect(brackets).toContainText(PLAYER_NAME);
      await expect(brackets).toBeInViewport();
      await brackets.getByRole('button', { name: 'Full draw & bracket standings' }).press('Enter');
      await expect(brackets.locator('.event-bracket-match')).toHaveCount(3);
      await expect(brackets).toContainText(`Winner · ${PLAYER_NAME}`);
      await navigation.getByRole('link', { name: 'Results', exact: true }).press('Enter');
      await expect(page).toHaveURL(/#event-results$/);
      await expect(page.getByRole('region', { name: 'Results', exact: true })).toBeInViewport();

      await ready(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
          .violations,
      ).toEqual([]);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: testInfo.outputPath('finished-knockout.png'), fullPage: true });
    });
  }
}

test('a finished multi-stage event keeps pool history even when the selected pool excludes the player', async ({
  page,
}) => {
  const { snapshot } = await mockEvent(page, { idle: true, bracket: true });
  const player = snapshot.matches.find(
    (match) => match.stage === 'group' && match.division === 'upper',
  )!.player1Id!;
  Object.assign(snapshot.plan, { status: 'complete', structure: 'dual_division' });
  const navigation = page.getByRole('navigation', { name: 'Event sections' });
  const poolLink = navigation.getByRole('link', { name: 'Pool schedule', exact: true });
  const poolSchedule = page.getByRole('region', { name: 'Pool schedule', exact: true });
  const poolHistory = poolSchedule.getByRole('button', { name: 'Pool schedule history' });
  const pools = page.getByRole('region', { name: 'Pools', exact: true });
  await page.goto(`/play/${PLAN_ID}?player=${player}`);
  await poolLink.press('Enter');
  await expect(page).toHaveURL(/#what-next$/);
  await poolHistory.press('Enter');
  await expect(poolSchedule.getByRole('heading', { name: 'Your pool rounds' })).toBeVisible();
  await expect(navigation.getByRole('link', { name: 'Pools', exact: true })).toBeVisible();

  await page.goto(`/play/${PLAN_ID}?player=${player}&pool=lower:0`);
  await poolLink.press('Enter');
  await poolHistory.press('Enter');
  await expect(poolSchedule).toContainText('No pool schedule is recorded for this view.');
  await navigation.getByRole('link', { name: 'Pools', exact: true }).press('Enter');
  await expect(page).toHaveURL(/#event-pools$/);
  await expect(pools).toContainText('No pool is published for this player in this view.');
});
