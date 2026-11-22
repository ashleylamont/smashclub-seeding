import { expect, test } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { mockEvent, PLAN_ID, PLAYER_NAME, ready } from './fixtures';
import type { PoolQualifierSlot } from '../src/lib/eventDisplay';

const cases = [
  ['withdrawn', 'You are withdrawn'],
  ['bracket_finished', 'Your published bracket run is finished'],
  ['pool_finished', 'You are outside the published finals field'],
  ['active', 'Championship final'],
] as const;

for (const width of [390, 1440])
  for (const theme of ['dark', 'light'] as const)
    for (const [state, summary] of cases)
      test(`${theme} ${width}px signed-out ${state} player sees consistent guidance with concurrent pools`, async ({
        page,
      }, testInfo) => {
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
        const fixture = await mockEvent(page, { bracket: state !== 'withdrawn', idle: true });
        const { snapshot } = fixture;
        const pool = snapshot.matches.find(
          (match) => match.stage === 'group' && match.player1Name === PLAYER_NAME,
        )!;
        const player = pool.player1Id!;
        for (const match of snapshot.matches) {
          if (
            match.stage === 'group' &&
            match.division === pool.division &&
            match.poolIndex === pool.poolIndex
          )
            Object.assign(match, {
              status: 'complete',
              outcome: 'played',
              score1: 2,
              score2: 0,
              winnerId: match.player1Id,
            });
        }
        const recorded = new Set(
          snapshot.matches.filter((match) => match.status === 'complete').map((match) => match.id),
        );
        for (const queue of snapshot.stationQueues) {
          if (queue.nextMatchId && recorded.has(queue.nextMatchId))
            Object.assign(queue, { nextMatchId: null });
          queue.upcoming = queue.upcoming.filter(({ matchId }) => !recorded.has(matchId));
        }

        if (state === 'withdrawn') Object.assign(snapshot, { withdrawals: [{ playerId: player }] });
        if (state === 'pool_finished') {
          Object.assign(pool, { score1: 0, score2: 2, winnerId: pool.player2Id });
          const bracket = snapshot.nativeBrackets[0]!;
          const qualifier: PoolQualifierSlot = {
            poolId: 'upper-pool-a',
            division: pool.division,
            poolIndex: pool.poolIndex!,
            place: 1,
            status: 'resolved',
            entrantId: pool.player2Id!,
            eligibleEntrantIds: [player, pool.player2Id!],
          };
          Object.assign(bracket, {
            entrantIds: [qualifier.entrantId],
            qualifierSlots: [qualifier],
          });
          snapshot.matches = snapshot.matches.filter(
            (match) =>
              !match.nativeBracketId || ![match.player1Id, match.player2Id].includes(player),
          );
        }
        if (state === 'active' || state === 'bracket_finished') {
          const bracket = snapshot.nativeBrackets[0]!;
          const [semiA, semiB, final] = snapshot.matches.filter(
            (match) => match.nativeBracketId === bracket.id,
          );
          bracket.entrantIds = [player, pool.player2Id!];
          Object.assign(semiB!, {
            status: 'complete',
            outcome: 'bye',
            player1Id: pool.player2Id,
            player1Name: pool.player2Name,
            winnerId: pool.player2Id,
          });
          Object.assign(final!, {
            status: state === 'active' ? 'ready' : 'complete',
            outcome: state === 'active' ? null : 'played',
            player2Id: pool.player2Id,
            player2Name: pool.player2Name,
            parent1MatchId: semiA!.id,
            parent2MatchId: semiB!.id,
            winnerId: state === 'active' ? null : pool.player2Id,
            score1: state === 'active' ? null : 0,
            score2: state === 'active' ? null : 2,
          });
          if (state === 'bracket_finished')
            Object.assign(bracket, { complete: true, winnerId: pool.player2Id });
        }

        const params = new URLSearchParams({
          player,
          pool: `${pool.division}:${pool.poolIndex}`,
        });
        await page.goto(`/play/${PLAN_ID}?${params}`);
        const hub = page.locator('.player-event-hub');
        const progress = page.getByRole('complementary', { name: 'Your progress' });
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await expect(hub.getByText(/scan a guest reporting QR/)).toBeVisible();
        await expect(progress.getByRole('heading')).toContainText(PLAYER_NAME);
        await expect(progress).toHaveAttribute('data-journey-state', state);
        await expect(progress).toContainText(summary);
        await expect(page.getByText(/follow published pairings for your next stage/i)).toHaveCount(
          0,
        );
        const nextMatch = progress.getByRole('button', { name: /^View (current|next) match$/ });
        const mixedStage = hub.getByText('Other pool sets are still in progress.', { exact: true });
        if (state === 'active') {
          await expect(mixedStage).toBeVisible();
          await nextMatch.press('Enter');
          await expect(page.locator('[data-player-match-id="fixture-final"]')).toBeFocused();
        } else {
          await expect(mixedStage).toHaveCount(0);
          await expect(nextMatch).toHaveCount(0);
          await expect(hub.getByText(/Brackets will appear here for this player/)).toHaveCount(0);
          if (state !== 'bracket_finished')
            await expect(hub.getByText('No bracket is recorded for this player.')).toBeVisible();
        }
        const nav = page.getByRole('navigation', { name: 'Event sections' });
        await nav.getByRole('link', { name: 'Results' }).press('Enter');
        await expect(page).toHaveURL(/#event-results$/);
        await expect(page.getByRole('region', { name: 'Results', exact: true })).toContainText(
          PLAYER_NAME,
        );
        if (state === 'active' || state === 'bracket_finished') {
          const draw = page.getByRole('button', { name: 'Full draw & bracket standings' });
          await draw.press('Enter');
          await expect(draw).toHaveAttribute('aria-expanded', 'true');
          await expect(page.getByRole('region', { name: 'Brackets', exact: true })).toContainText(
            'Championship final',
          );
        }
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
        await page.evaluate(() => window.scrollTo(0, 0));
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
        await page.screenshot({
          path: testInfo.outputPath(`stage-guidance-${state}-${theme}-${width}.png`),
          fullPage: true,
          animations: 'disabled',
        });
        expect(fixture.unexpected).toEqual([]);
      });
