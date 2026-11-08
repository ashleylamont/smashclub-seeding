import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Desk } from '../src/pages/admin/dispatchTypes';
import { mockEvent, PLAN_ID, ready } from './fixtures';

const pairName = 'Alexandria from Western Sydney / Jordan with a long tournament alias';
const memberName = 'Jordan with a long tournament alias';

for (const theme of ['dark', 'light'] as const) {
  for (const width of [390, 1440]) {
    test(`snooze recovery uses the exact untaken call at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const { overview, unexpected } = await mockEvent(page, { role: 'admin', idle: true });
      const match = overview.matches.find((row) => row.status === 'ready')!;
      Object.assign(match, {
        player1Name: pairName,
        status: 'playing',
        started: false,
        called: true,
        stationId: null,
        resourceRevision: 12,
      });
      const members = [
        {
          entrantId: match.player1Id!,
          playerId: 'team-member-1',
          name: 'Alexandria from Western Sydney',
          availability: 'available',
          revision: 3,
        },
        {
          entrantId: match.player1Id!,
          playerId: 'team-member-2',
          name: memberName,
          availability: 'available',
          revision: 3,
        },
      ] as const;
      overview.reports = [];
      const dispatch: Desk = {
        mode: 'shared',
        capacity: 2,
        active: 1,
        overCapacity: 0,
        resourceRevision: 12,
        queueRevision: 0,
        stations: [],
        pools: [],
        entrants: [
          {
            id: match.player1Id!,
            name: pairName,
            revision: 3,
            availability: 'available',
            members: members.map(({ playerId, availability }) => ({
              id: playerId,
              availability,
            })),
          },
        ],
        queue: [
          {
            matchId: match.id,
            state: 'called',
            waitingSince: 0,
            downstream: 0,
            reason: 'Awaiting actual play',
            canStart: false,
            canDispatchOrdinary: false,
            eligibleStationIds: [],
            reasons: [],
          },
        ],
      };
      Object.assign(overview, {
        members,
        operatorDispatch: dispatch,
        sharedDispatch: { active: 1, capacity: 2, overCapacity: 0 },
      });
      await page.goto(`/operate/${PLAN_ID}`);
      const desk = page.getByRole('region', { name: 'TO match queue' });
      const disclosure = desk.getByRole('button', { name: 'Player availability and pool holds' });
      await disclosure.press('Enter');
      const snooze = desk.getByRole('button', { name: `Snooze ${pairName}`, exact: true });
      const memberSnooze = desk.getByRole('button', { name: `Snooze ${memberName}`, exact: true });
      await expect(snooze).toBeDisabled();
      await expect(memberSnooze).toBeDisabled();
      await expect(
        desk.getByText('Return the untaken call before changing availability.'),
      ).toBeVisible();
      const recovery = desk.getByRole('button', { name: /^Open call for / });
      await expect(recovery).toHaveCount(1);
      await page.keyboard.press('Tab');
      await expect(recovery).toBeFocused();
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
      await page.screenshot({
        path: testInfo.outputPath('called-availability.png'),
        fullPage: true,
      });
      await recovery.press('Enter');
      const call = desk.locator(`article[data-match-id="${match.id}"]`);
      const returnTarget = call.locator(`[id="return-call-${match.id}"]`);
      await expect(returnTarget).toHaveText('Return untaken call');
      await expect(returnTarget).toBeFocused();

      // A second organiser starts this same set before the first acts.
      Object.assign(match, { started: true, called: false, resourceRevision: 13 });
      dispatch.resourceRevision = 13;
      dispatch.queue[0]!.state = 'playing';
      await expect(recovery).toHaveCount(0);
      await expect(returnTarget).toHaveCount(0);
      await expect(snooze).toBeDisabled();
      await expect(memberSnooze).toBeDisabled();
      await expect(
        desk.getByText(
          'Finish the started match or release its setup before changing availability.',
        ),
      ).toBeVisible();
      const release = call.getByRole('button', { name: 'Release capacity' });
      await expect(release).not.toBeFocused();
      const confirm = page.getByRole('alertdialog');
      await page.keyboard.press('Enter');
      await expect(confirm).toBeHidden();
      await release.press('Enter');
      await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
      await expect(confirm).toContainText('Actual play and live scores remain recorded.');
      await page.keyboard.press('Escape');
      await expect(confirm).toBeHidden();
      await expect(release).toBeFocused();
      await page.screenshot({
        path: testInfo.outputPath('started-availability.png'),
        fullPage: true,
      });
      expect(unexpected).toEqual([]);
    });
  }
}
