import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { chooseOption } from '../test-support/controls';
import { mockEvent, PLAN_ID, ready } from './fixtures';

for (const theme of ['dark', 'light'] as const) {
  for (const width of [390, 1440]) {
    test(`${theme} ${width}px closed player hub retains facts without live station calls`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      const guest = width === 390;
      await page.addInitScript(
        ({ theme, planId, guest }) => {
          localStorage.setItem('smashclub:theme', theme);
          if (guest)
            localStorage.setItem(
              `nemesis:guest:${planId}`,
              JSON.stringify({
                sessionToken: 'closed-event-fixture-pass'.repeat(2),
                expiresAt: null,
              }),
            );
        },
        { theme, planId: PLAN_ID, guest },
      );
      await page.clock.install({ time: new Date('2026-10-04T00:00:00Z') });
      const options = { bracket: true, failure: false };
      const fixture = await mockEvent(page, options);
      const { matches, plan, stations, stationQueues } = fixture.snapshot;
      const pool = matches.find((row) => row.status === 'playing')!;
      const player = pool.player1Id!;
      const station = stations.find((row) => row.id === pool.stationId)!;
      const [projected, recorded, forfeit] = matches.filter(
        (row) => row.player1Id === player && row.stage === 'group' && row.status === 'ready',
      );
      const bye = matches.find((row) => row.id === 'fixture-semi-a')!;
      const noContest = matches.find((row) => row.id === 'fixture-semi-b')!;
      const final = matches.find((row) => row.id === 'fixture-final')!;
      Object.assign(final, {
        status: 'playing',
        stationId: station.id,
        started: true,
        called: false,
        player2Id: pool.player2Id,
        player2Name: pool.player2Name,
        score1: 4,
        score2: 3,
      });
      Object.assign(pool, { status: 'ready', stationId: null, started: false });
      Object.assign(recorded!, {
        status: 'complete',
        outcome: 'played',
        winnerId: recorded!.player1Id,
        score1: 2,
        score2: 0,
        pendingDisputeCount: 1,
      });
      Object.assign(forfeit!, {
        status: 'complete',
        outcome: 'forfeit',
        winnerId: forfeit!.player1Id,
      });
      Object.assign(noContest, {
        player2Id: projected!.player2Id,
        player2Name: projected!.player2Name,
        blockedReason: 'Both players withdrawn: no contest; no winner or score recorded',
      });
      Object.assign(station, { currentMatchId: final.id, status: 'occupied' });
      Object.assign(
        stationQueues.find((queue) => queue.stationId === station.id)!,
        {
          currentMatchId: final.id,
          nextMatchId: projected!.id,
        },
      );
      // A cached guest response may still supply that credential's report history after closure.
      const reports = [
        {
          id: 'private-dispute',
          matchId: recorded!.id,
          status: 'pending',
          isDispute: true,
          score1: 1,
          score2: 2,
        },
        {
          id: 'private-unreviewed',
          matchId: final.id,
          status: 'pending',
          isDispute: false,
          score1: 2,
          score2: 1,
        },
      ];
      fixture.responses['eventOps.guests.matches'] = { ...fixture.snapshot, reports };
      let closedGuestPolls = 0;
      if (guest)
        await page.route('**/api/trpc/eventOps.guests.matches*', async (route) => {
          if (plan.status !== 'cancelled') return route.fallback();
          closedGuestPolls++;
          const error = {
            error: {
              message: 'Guest reporting is unavailable.',
              code: -32003,
              data: { code: 'FORBIDDEN', httpStatus: 403 },
            },
          };
          await route.fulfill({
            status: 403,
            json: new URL(route.request().url()).searchParams.has('batch') ? [error] : error,
          });
        });
      const path = `/${guest ? 'guest' : 'play'}/${PLAN_ID}?player=${player}`;
      await page.goto(path);
      const finalCard = page.locator('article.ops-match').filter({ hasText: final.label });
      const recordedCard = page.locator('article.ops-match').filter({ hasText: recorded!.label });
      await expect(finalCard).toContainText(`Playing now · ${station.name}`);
      if (guest) await expect(recordedCard).toContainText('Different score awaiting TO review');
      const interrupted = page.getByText(
        'Live updates interrupted. Scores shown may be out of date.',
      );
      options.failure = true;
      await expect
        .poll(async () => {
          await page.clock.runFor(2000);
          return interrupted.isVisible();
        })
        .toBe(true);
      await expect(finalCard).toContainText('Playing now');
      await expect(finalCard.getByRole('spinbutton')).toHaveCount(0);
      options.failure = false;
      plan.status = 'cancelled';
      await expect
        .poll(async () => {
          await page.clock.runFor(2000);
          return finalCard.getByText(/No result recorded/).isVisible();
        })
        .toBe(true);
      await expect(interrupted).toHaveCount(0);
      await expect(finalCard).toContainText(`No result recorded · ${station.name}`);
      await expect(finalCard).not.toHaveClass(/ops-match-playing/);
      await expect(page.locator('article.ops-match').getByRole('spinbutton')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Find next match' })).toHaveCount(0);
      if (guest) {
        await expect
          .poll(async () => {
            await page.clock.runFor(2000);
            return closedGuestPolls;
          })
          .toBeGreaterThan(0);
        await expect(recordedCard).toContainText('Your report: 1 – 2 · Dispute unresolved');
        await expect(finalCard).toContainText('Your report: 2 – 1 · No review decision recorded');
      } else {
        await expect(page.getByText('Your report:', { exact: false })).toHaveCount(0);
      }
      await expect(recordedCard).toContainText('Confirmed result: 2 – 0');
      await expect(recordedCard).toContainText(
        'An unresolved report differs from this official result.',
      );
      await expect(recordedCard.getByRole('button', { name: /report|submit|flag/i })).toHaveCount(
        0,
      );
      await expect(page.getByRole('columnheader', { name: 'No result' })).toBeVisible();

      await page.getByRole('button', { name: 'Full draw & bracket standings' }).press('Enter');
      const finalDraw = page.locator(`[data-match-id="${final.id}"]`);
      await expect(finalDraw).toHaveAccessibleName(/No result recorded/);
      await expect(finalDraw).not.toHaveClass(/is-playing/);
      await expect(finalDraw.getByLabel(/Score [43]/)).toHaveCount(0);
      await expect(page.locator(`[data-match-id="${bye.id}"]`)).toHaveAccessibleName(/Bye/);
      await expect(page.locator(`[data-match-id="${noContest.id}"]`)).toHaveAccessibleName(
        /No contest/,
      );
      await expect(
        page.locator('.player-bracket-path').getByRole('listitem').filter({
          hasText: 'Championship final',
        }),
      ).toContainText('No result recorded');
      const byePath = page.locator('.player-bracket-path').getByRole('listitem').filter({
        hasText: bye.label,
      });
      await expect(byePath).toContainText('advanced automatically');
      await expect(byePath).not.toContainText('vs Bye');
      const recordedResult = page
        .getByRole('region', { name: 'Results', exact: true })
        .getByRole('article')
        .filter({ hasText: recorded!.player2Name! });
      await expect(recordedResult.locator('.event-match-meta')).toContainText(recorded!.label);
      await page.getByRole('link', { name: 'Pool schedule', exact: true }).press('Enter');
      await expect(page).toHaveURL(/#what-next$/);
      const schedule = page.getByRole('region', { name: 'Pool schedule', exact: true });
      await schedule
        .getByRole('button', { name: 'Pool schedule history', exact: true })
        .press('Enter');
      const history = page.locator('.pool-flow-rounds');
      await history.getByRole('button', { name: /Pool A.*rounds/ }).press('Enter');
      await expect(history).toContainText('No result recorded');
      await expect(history).toContainText('Forfeit');
      await expect(history).not.toContainText(/Upcoming|Playing now|Follow the station queue/);
      await expect(page.locator('#pool-station-queues')).toHaveCount(0);
      await ready(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(
        (
          await new AxeBuilder({ page })
            .include('.player-event-hub')
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: testInfo.outputPath('closed-player-hub.png'), fullPage: true });

      await page.getByRole('button', { name: 'Match filters' }).press('Enter');
      const view = page.getByRole('combobox', { name: 'Match view' });
      await chooseOption(view, 'queue');
      await expect(view).toContainText('Station pairings & my reports');
      await expect(finalCard).toBeVisible();
      const projection = page.locator('article.ops-match').filter({ hasText: projected!.label });
      await expect(projection).toHaveCount(0);
      if (guest) await expect(recordedCard).toContainText('Dispute unresolved');
      await chooseOption(view, 'mine');
      await expect(projection).toBeVisible();
      await chooseOption(page.getByRole('combobox', { name: 'Station', exact: true }), station.id);
      await expect(finalCard).toBeVisible();
      await expect(projection).toHaveCount(0);
      expect(fixture.unexpected).toEqual([]);
    });
  }
}
