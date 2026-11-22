import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { chooseOption } from '../test-support/controls';
import { mockEvent, PLAN_ID, ready } from './fixtures';

const cases = [
  { theme: 'dark', width: 390, status: 'Playing now' },
  { theme: 'light', width: 390, status: 'Called' },
  { theme: 'dark', width: 1440, status: 'Play next' },
  { theme: 'light', width: 1440, status: 'Playing now' },
] as const;

test('match shortcut skips an earlier ready row whose opponent is unresolved', async ({ page }) => {
  const fixture = await mockEvent(page, { role: 'player', idle: true });
  fixture.snapshot.stationQueues = [];
  const matchIndex = fixture.snapshot.matches.findIndex((item) => item.stationId);
  const match = fixture.snapshot.matches[matchIndex]!;
  const unresolved = Object.assign(
    { ...match },
    {
      id: 'unresolved-ready-match',
      stationId: null,
      player2Id: null,
      player2Name: null,
      label: 'Unresolved ready pairing',
    },
  );
  fixture.snapshot.matches.splice(matchIndex, 0, unresolved);

  await page.goto(`/play/${PLAN_ID}?player=${match.player1Id}`);
  const progress = page.getByRole('complementary', { name: 'Your progress' });
  const cards = page.locator('article.ops-match');
  await expect(progress).toContainText(match.label);
  await expect(cards.first()).toContainText(unresolved.label);
  await progress.getByRole('button', { name: 'View next match' }).press('Enter');
  const card = cards.filter({ hasText: match.label });
  await expect(card).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(card.getByRole('spinbutton').first()).toBeFocused();
  expect(fixture.starts).toEqual([]);
  expect(fixture.submissions).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

for (const { theme, width, status } of cases) {
  test(`${theme} ${width}px match shortcut lands on the ${status} card`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.emulateMedia({ reducedMotion: width === 390 ? 'reduce' : 'no-preference' });
    await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
    const fixture = await mockEvent(page, { role: 'player' });
    const match = fixture.snapshot.matches.find((item) => item.status === 'playing')!;
    match.player2Name = 'Chrom with an exceptionally long tournament alias';
    const station = fixture.snapshot.stations.find((item) => item.id === match.stationId)!;
    const queue = fixture.snapshot.stationQueues.find((item) => item.stationId === station.id)!;
    if (status === 'Called') {
      Object.assign(fixture.snapshot, {
        callSnapshotVersion: 1,
        sharedDispatch: { capacity: 4, active: 1, overCapacity: 0 },
      });
      Object.assign(match, { called: true, started: false, callSequence: 1 });
    } else if (status === 'Play next') {
      Object.assign(match, { status: 'ready', stationId: null, started: false });
      Object.assign(station, { currentMatchId: null, status: 'free' });
      Object.assign(queue, { currentMatchId: null, nextMatchId: match.id });
    }

    await page.goto(`/play/${PLAN_ID}?player=${match.player1Id}`);
    const matches = page.getByRole('region', { name: 'Find my matches and report scores' });
    const cards = matches.locator('article.ops-match');
    const opponent = page.getByRole('heading', {
      name: `${match.player1Name} vs ${match.player2Name}`,
    });
    const card = cards.filter({ has: opponent });
    const score = card.getByRole('spinbutton').first();
    const shortcut = matches.getByRole('button', {
      name: status === 'Play next' ? 'View next match' : 'View current match',
    });

    const view = matches.getByRole('combobox', { name: 'Match view' });
    await matches.getByRole('button', { name: 'Match filters' }).click();
    if (status === 'Play next') {
      await chooseOption(view, 'results');
      await expect(card).toHaveCount(0);
    } else {
      await score.fill('2');
      await cards.nth(1).getByRole('spinbutton').first().fill('1');
    }
    await ready(page);
    await expect(shortcut).toBeVisible();
    if (theme === 'light' && width === 1440) {
      await shortcut.click();
    } else {
      await shortcut.focus();
      await page.keyboard.press('Enter');
    }
    await expect(card).toBeFocused();
    await expect(card).toContainText(`${status} · ${station.name}`);
    await expect(card).toHaveCSS('outline-style', 'solid');
    await expect(card.getByRole('heading')).toBeInViewport();
    await expect
      .poll(() =>
        card.evaluate((element) =>
          Math.abs(
            element.getBoundingClientRect().top -
              document.querySelector('.app-nav')!.getBoundingClientRect().bottom -
              16,
          ),
        ),
      )
      .toBeLessThanOrEqual(1);
    await expect(view).toHaveAttribute('data-value', 'mine');
    await expect(matches.getByLabel('Show matches for')).toHaveAttribute(
      'data-value',
      match.player1Id!,
    );
    if (status !== 'Play next') {
      await expect(score).toHaveValue('2');
      await expect(cards.nth(1).getByRole('spinbutton').first()).toHaveValue('1');
    }
    await page.screenshot({ path: testInfo.outputPath(`match-shortcut-${theme}-${width}.png`) });
    await page.keyboard.press('Tab');
    await expect(score).toBeFocused();
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
    expect(fixture.submissions).toEqual([]);
    expect(fixture.starts).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
}
