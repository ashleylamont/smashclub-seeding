import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { bracketFixture } from '../test/fixtures/brackets';
import { mockEvent, PLAN_ID, PLAYER_NAME, ready } from './fixtures';

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test(`missing finals explain the next step at ${width}px in ${theme} mode`, async ({
      page,
    }, testInfo) => {
      const fixture = await mockEvent(page, { role: 'player', idle: true });
      for (const match of fixture.snapshot.matches) {
        if (match.stage !== 'group' || match.status === 'complete') continue;
        Object.assign(match, {
          status: 'complete',
          outcome: 'played',
          winnerId: match.player1Id,
          score1: 2,
          score2: 0,
        });
      }
      Object.assign(fixture.overview, {
        stationQueues: [],
        reports: fixture.overview.reports.filter(({ status }) => status !== 'pending'),
        finalization: {
          kind: 'missing_draw',
          message: 'Create the missing finals draws before publishing results.',
        },
      });
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      await page.goto(`/operate/${PLAN_ID}?view=draw`);
      const finalize = page.getByRole('button', { name: 'Finalize native results', exact: true });
      await expect(finalize).toBeDisabled();
      await expect(finalize).toHaveAccessibleDescription(/Create the missing finals draws/);
      await page.getByRole('button', { name: 'Go to finals preview' }).press('Enter');
      await expect(page.getByRole('button', { name: 'Preview finals', exact: true })).toBeFocused();
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
      await ready(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(
        (
          await new AxeBuilder({ page })
            .include('.ops-page')
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await page.screenshot({
        path: testInfo.outputPath(`missing-finals-${theme}-${width}.png`),
        fullPage: true,
      });
      expect(fixture.unexpected).toEqual([]);
    });

for (const [width, theme, double] of [
  [390, 'dark', false],
  [390, 'light', true],
  [1440, 'dark', true],
  [1440, 'light', false],
] as const)
  test(`an unfinished native knockout gives the actual blocker at ${width}px in ${theme} mode`, async ({
    page,
  }, testInfo) => {
    const fixture = await mockEvent(page, { role: 'player', idle: true });
    const entrants = [
      { id: 'entrant-0', name: PLAYER_NAME },
      { id: 'entrant-1', name: 'Bea' },
      { id: 'entrant-2', name: 'Cam' },
    ];
    const publicNames = new Map(entrants.map(({ id, name }) => [id, name]));
    const matches = bracketFixture(entrants.length, double).map((match) => ({
      ...fixture.snapshot.matches[0]!,
      ...match,
      player1Name: publicNames.get(match.player1Id ?? '') ?? null,
      player2Name: publicNames.get(match.player2Id ?? '') ?? null,
    }));
    const next = matches.find(({ status }) => status === 'ready')!;
    const blocker = 'Finish the remaining matches before publishing results.';
    Object.assign(fixture.overview.plan, {
      status: 'underway',
      structure: double ? 'double_elimination' : 'single_elimination',
    });
    Object.assign(fixture.overview, {
      entrants,
      matches,
      stationQueues: [],
      poolRounds: [],
      poolSchedules: [],
      nativeBrackets: [
        {
          id: 'rehearsal',
          division: 'upper',
          stage: 'main',
          entrantIds: entrants.map(({ id }) => id),
          complete: false,
          winnerId: null,
          standings: [],
        },
      ],
      finalization: { kind: 'unfinished_matches', matchId: next.id, message: blocker },
    });

    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
    await page.goto(`/operate/${PLAN_ID}?view=draw`);
    const controls = page.locator('.native-finals-controls');
    const finalize = controls.getByRole('button', { name: 'Finalize native results' });
    await expect(finalize).toBeDisabled();
    await expect(finalize).toHaveAccessibleDescription(blocker);
    await expect(
      controls.getByText(/outstanding matches|reset final|Results are ready/i),
    ).toHaveCount(0);
    const draw = page.getByRole('region', { name: 'Tournament draw' });
    await expect(draw.getByText('Reset final · If needed', { exact: true })).toHaveCount(
      double ? 1 : 0,
    );
    await ready(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    expect(
      (
        await new AxeBuilder({ page })
          .include('.ops-page')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await controls.screenshot({ path: testInfo.outputPath('unfinished-knockout.png') });

    await controls.getByRole('button', { name: 'Go to unfinished match' }).press('Enter');
    await expect(page.getByRole('tab', { name: 'Run matches' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByText('Showing the selected match.')).toBeFocused();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    expect(fixture.unexpected).toEqual([]);
  });
