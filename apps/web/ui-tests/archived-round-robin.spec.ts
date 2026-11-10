import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mockEvent, PLAN_ID, ready } from './fixtures';

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test(`${theme} ${width}px archived native round robin presents the organiser’s tied order`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const { snapshot, responses, unexpected } = await mockEvent(page, { idle: true });
      const entrants = snapshot.entrants.slice(0, 4);
      const [first, winner, third, fourth] = entrants;
      first!.name = 'Arden with a long tournament alias';
      winner!.name = 'Blair with a long tournament alias from Western Sydney';
      third!.name = 'Cameron';
      fourth!.name = 'Devon';
      const order = [winner!, first!, fourth!, third!];
      const template = snapshot.matches[0]!;
      const matches = [
        [first!, third!],
        [first!, fourth!],
        [winner!, first!],
        [winner!, third!],
        [third!, fourth!],
        [fourth!, winner!],
      ].map(([won, lost], index) => ({
        ...template,
        id: `recorded-${index}`,
        stage: 'group',
        division: 'upper',
        label: 'Open pool 1',
        started: true,
        poolIndex: 0,
        player1Id: won!.id,
        player1Name: won!.name,
        player2Id: lost!.id,
        player2Name: lost!.name,
        score1: 2,
        score2: 0,
        winnerId: won!.id,
        status: 'complete',
        outcome: 'played',
      }));
      const placements = order.map(({ id }, index) => ({
        ...snapshot.placements[0]!,
        id: `place-${id}`,
        division: 'upper',
        poolIndex: 0,
        playerId: id,
        place: index + 1,
      }));
      responses['eventOps.snapshot'] = {
        ...snapshot,
        matches,
        placements,
        plan: {
          ...snapshot.plan,
          status: 'complete',
          structure: 'round_robin',
          resultsSlug: 'open-round-robin-r1',
        },
        nativeBrackets: [
          {
            id: 'published-round-robin',
            division: 'upper',
            stage: 'main',
            entrantIds: order.map(({ id }) => id),
            complete: true,
            winnerId: winner!.id,
            standings: order.map(({ id }, i) => ({ playerId: id, place: i + 1 })),
          },
        ],
      };
      await page.goto(`/play/${PLAN_ID}?player=${winner!.id}#event-brackets`);
      await expect(page.locator('#event-brackets')).toContainText(
        'This event uses pool standings to decide the result; there is no finals bracket.',
      );
      await expect(page.getByRole('heading', { name: 'Your bracket path' })).toHaveCount(0);
      await expect(page.getByText(/Confirmed championship place/)).toHaveCount(0);
      await expect(page.locator('.event-pool-ranking li')).toHaveText(
        order.map(({ name }, i) => `${i + 1} ${name}`),
      );
      await expect(
        page.getByRole('link', { name: 'Final standings and club results →' }),
      ).toHaveAttribute('href', '/events/open-round-robin-r1');
      await ready(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(
        (await new AxeBuilder({ page }).include('.player-event-hub').analyze()).violations,
      ).toEqual([]);
      await page.evaluate(() => scrollTo(0, 0));
      await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
      await ready(page);
      await page.screenshot({
        path: testInfo.outputPath('round-robin-player.png'),
        fullPage: true,
      });

      const obsWidth = width === 390 ? 1280 : 1920;
      await page.setViewportSize({ width: obsWidth, height: obsWidth === 1280 ? 720 : 1080 });
      await page.goto(`/overlay/${PLAN_ID}?presentation=progress`);
      const progress = page.getByRole('region', { name: 'Tournament progress' });
      await expect(
        progress.getByRole('heading', { name: 'Round-robin results', exact: true }),
      ).toBeVisible();
      await expect(progress.getByText(`Confirmed winner · ${winner!.name}`)).toBeVisible();
      const standings = progress.getByRole('table', { name: 'Confirmed round-robin standings' });
      const rows = standings.getByRole('row');
      await expect(rows.locator('td:nth-child(2)')).toHaveText(order.map(({ name }) => name));
      // The tied set records appear beside the official places in the TO’s order.
      await expect(rows.locator('td:nth-child(3)')).toHaveText(['2–1', '2–1', '1–2', '1–2']);
      await expect(rows.locator('td:nth-child(4)')).toHaveText(['+2', '+2', '-2', '-2']);
      await expect(progress.getByText('No played sets in this bracket.')).toHaveCount(0);
      await ready(page);
      expect(
        (await new AxeBuilder({ page }).include('.broadcast-intermission').analyze()).violations,
      ).toEqual([]);
      expect(
        await page
          .locator('.intermission-content')
          .evaluate(
            (node) =>
              node.scrollHeight <= node.clientHeight && node.scrollWidth <= node.clientWidth,
          ),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath('round-robin-obs.png'),
        omitBackground: true,
      });
      await page.getByRole('button', { name: 'Next page', exact: true }).press('Enter');
      await expect(progress).toContainText('Page 2 /');
      await expect(standings).toHaveCount(0);
      await expect(progress.getByRole('heading', { name: 'Round-robin set records' })).toHaveCount(
        0,
      );
      expect(unexpected).toEqual([]);
    });
