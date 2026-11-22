import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { chooseOption } from '../test-support/controls';
import { mockEvent, PLAN_ID, ready } from './fixtures';

const snapshotPath = /\/api\/trpc\/[^?]*eventOps\.snapshot(?:[?,]|$)/;
const opponent = 'Alexandria with a long tournament alias from Western Sydney';

async function callFixture(page: Page) {
  const fixture = await mockEvent(page, { bracket: true });
  const snapshot = Object.assign(fixture.snapshot, {
    callSnapshotVersion: 10,
    sharedDispatch: { capacity: 4, active: 0, overCapacity: 0 },
  });
  const match = Object.assign(
    snapshot.matches.find((item) => item.status === 'playing')!,
    {
      status: 'ready',
      called: false,
      started: false,
      stationId: null,
      callSequence: undefined as number | undefined,
      callLocation: null as string | null,
    },
  );
  for (const row of snapshot.matches) {
    if (row.player1Id === match.player2Id) row.player1Name = opponent;
    if (row.player2Id === match.player2Id) row.player2Name = opponent;
  }
  const call = (version: number, location: string | null, stationId: string | null = null) => {
    snapshot.callSnapshotVersion = version;
    Object.assign(match, {
      status: 'playing',
      called: true,
      started: false,
      stationId,
      callLocation: location,
      callSequence: version,
    });
  };
  const poll = async () => {
    await Promise.all([
      page.waitForResponse((response) => snapshotPath.test(response.url())),
      page.clock.fastForward(2600),
    ]);
    await ready(page);
  };
  return { ...fixture, snapshot, match, call, poll };
}

test('player alerts baseline on reload, ignore stale/repeated polls and only announce a committed new call', async ({
  page,
}, testInfo) => {
  await page.clock.install();
  const { snapshot, match, call, poll, starts, submissions, unexpected } = await callFixture(page);
  const alerts = page.getByRole('switch', { name: 'Match call alerts' });
  const announcement = page.getByRole('status', { name: 'Player call announcements' });
  await page.goto(`/play/${PLAN_ID}?player=${match.player1Id}`);
  await expect(alerts).not.toBeChecked();
  call(11, 'Window setup');
  await poll();
  await expect(announcement).toBeEmpty();
  await alerts.press('Space');
  await expect(alerts).toBeChecked();
  await expect(announcement).toBeEmpty();
  await page.reload();
  await expect(alerts).toBeChecked();
  await expect(announcement).toBeEmpty();

  snapshot.callSnapshotVersion = 12;
  Object.assign(match, { status: 'ready', called: false, callSequence: undefined });
  await poll();
  await expect(announcement).toContainText('returned to the queue');
  await page.screenshot({ path: testInfo.outputPath('returned.png') });
  call(11, 'Window setup');
  await poll();
  await expect(announcement).toContainText('returned to the queue');
  await expect(announcement).not.toContainText('Window setup');

  call(13, null, snapshot.stations[0]!.id);
  await poll();
  await expect(announcement).toContainText(`Match called. Play ${opponent} at Stage.`);
  const banner = announcement.locator('.banner');
  const bannerElement = await banner.elementHandle();
  await poll();
  expect(await bannerElement!.evaluate((element) => element.isConnected)).toBe(true);

  await page.context().setOffline(true);
  await expect(page.getByText('Live updates interrupted.', { exact: false })).toBeVisible();
  await expect(announcement).toBeEmpty();
  await page.context().setOffline(false);
  await poll();
  await expect(announcement).toBeEmpty();

  call(14, 'Courtyard setup');
  await poll();
  await expect(announcement).toContainText(`Match called. Play ${opponent} at Courtyard setup.`);
  snapshot.callSnapshotVersion = 15;
  match.callLocation = 'Updated setup';
  await poll();
  await expect(announcement).toBeEmpty();

  call(16, 'Window setup');
  await poll();
  await expect(announcement).toContainText('Window setup');
  snapshot.callSnapshotVersion = 17;
  Object.assign(match, { started: true, called: false, callSequence: undefined });
  await poll();
  await expect(announcement).toBeEmpty();

  call(18, 'Window setup');
  Object.assign(match, { status: 'complete', winnerId: match.player1Id, score1: 2, score2: 0 });
  await poll();
  await expect(announcement).toBeEmpty();

  call(19, null);
  Object.assign(match, { winnerId: null, score1: null, score2: null });
  await poll();
  await expect(announcement).toContainText('Any available ordinary setup');
  snapshot.callSnapshotVersion = 20;
  Object.assign(match, { status: 'blocked', called: false, callSequence: undefined });
  await poll();
  await expect(announcement).toContainText('Call cancelled.');
  await expect(announcement).not.toContainText('Any available ordinary setup');

  const select = page.getByRole('combobox', { name: 'Show matches for' });
  await chooseOption(select, match.player2Id!);
  await expect(alerts).not.toBeChecked();
  await expect(announcement).toBeEmpty();
  await chooseOption(select, '');
  await expect(alerts).toHaveCount(0);
  expect(starts).toEqual([]);
  expect(submissions).toEqual([]);
  expect(unexpected).toEqual([]);
});

for (const theme of ['dark', 'light']) {
  for (const width of [390, 1440]) {
    test(`${theme} ${width}px player call banner wraps and preserves keyboard focus`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      await page.clock.install();
      const { match, call, poll, unexpected } = await callFixture(page);
      await page.goto(`/play/${PLAN_ID}?player=${match.player1Id}`);
      const selection = page.getByRole('combobox', { name: 'Show matches for' });
      const alerts = page.getByRole('switch', { name: 'Match call alerts' });
      const announcement = page.getByRole('status', { name: 'Player call announcements' });
      await expect(selection).toBeVisible();
      await selection.focus();
      await page.keyboard.press('Tab');
      await expect(alerts).toBeFocused();
      await page.keyboard.press('Space');
      await expect(alerts).toBeChecked();
      await expect(announcement).toBeEmpty();
      await expect(announcement).toHaveAttribute('aria-atomic', 'true');
      const location = 'The setup beside the courtyard entrance near the registration desk';
      call(11, location);
      await poll();
      await expect(announcement).toContainText(`Match called. Play ${opponent} at ${location}.`);
      await expect(alerts).toBeFocused();
      await expect(announcement.locator('.banner')).toHaveCSS('animation-name', 'none');
      expect(
        await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
      ).toBe(true);
      await page.getByRole('button', { name: 'Full draw & bracket standings' }).click();
      await expect(page.locator('.event-brackets')).toBeVisible();
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
      await ready(page);
      await page.screenshot({ path: testInfo.outputPath('viewport.png') });
      await page.screenshot({ path: testInfo.outputPath('active.png'), fullPage: true });
      await alerts.press('Space');
      await expect(alerts).not.toBeChecked();
      await expect(announcement).toBeEmpty();
      expect(unexpected).toEqual([]);
    });
  }
}
