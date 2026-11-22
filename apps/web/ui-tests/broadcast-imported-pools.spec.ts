import { expect, test } from '@playwright/test';
import { mockEvent, PLAN_ID, ready } from './fixtures';

for (const [width, height, colorScheme] of [
  [1280, 720, 'dark'],
  [1920, 1080, 'light'],
] as const) {
  test(`${width}px intermission shows imported pool places without operational matches`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    const { snapshot, responses, unexpected } = await mockEvent(page, { idle: true });
    const entrants = [
      { id: 'winner', name: 'Sunset Observatory Recording Desk' },
      { id: 'runner-up', name: 'Harbour Lantern Collector' },
      { id: 'lower', name: 'Canary' },
    ];
    const placement = snapshot.placements[0]!;
    responses['eventOps.snapshot'] = {
      ...snapshot,
      plan: { ...snapshot.plan, bracketMode: 'challonge' },
      matches: [],
      entrants,
      placements: [
        {
          ...placement,
          id: 'second',
          division: 'upper',
          playerId: 'runner-up',
          place: 2,
          source: 'challonge',
        },
        { ...placement, id: 'lower', playerId: 'lower', place: 1, source: 'challonge' },
        {
          ...placement,
          id: 'first',
          division: 'upper',
          playerId: 'winner',
          place: 1,
          source: 'challonge',
        },
      ],
    };
    const overlay = `/overlay/${PLAN_ID}?presentation=progress&controls=0`;
    await page.goto(overlay);
    const progress = page.getByRole('region', { name: 'Tournament progress' });
    const upper = progress.getByRole('table', { name: 'upper · Pool A' });
    const lower = progress.getByRole('table', { name: 'lower · Pool A' });
    const expectUpperPlaces = async () => {
      await expect(upper.getByRole('caption')).toHaveText('Placements from Challonge');
      const rows = upper.locator('tbody tr');
      await expect(rows).toHaveCount(2);
      expect(
        await rows.evaluateAll((items) =>
          items.map((row) =>
            [...(row as HTMLTableRowElement).cells].map((cell) => cell.textContent),
          ),
        ),
      ).toEqual([
        ['1', entrants[0]!.name, '—', '—', '—'],
        ['2', entrants[1]!.name, '—', '—', '—'],
      ]);
      await expect(progress.getByRole('progressbar', { name: 'Pool sets completed' })).toHaveCount(
        0,
      );
    };
    const capture = async (scope: string) => {
      await ready(page);
      expect(
        await progress.locator('.intermission-content').evaluate((content) => ({
          horizontal: content.scrollWidth > content.clientWidth,
          vertical: content.scrollHeight > content.clientHeight,
        })),
      ).toEqual({ horizontal: false, vertical: false });
      await page.screenshot({ path: testInfo.outputPath(`imported-pools-${scope}-${width}.png`) });
    };
    await expect(upper).toBeVisible();
    await expect(lower).toContainText(entrants[2]!.name);
    await expectUpperPlaces();
    await capture('whole');

    await page.goto(`${overlay}&pool=upper%3A0`);
    await expect(upper).toBeVisible();
    await expect(lower).toHaveCount(0);
    await expectUpperPlaces();
    await capture('scoped');
    expect(unexpected).toEqual([]);
  });
}
