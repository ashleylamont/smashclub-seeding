import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { EventPlanView } from '../src/lib/apiTypes';
import { chooseOption } from '../test-support/controls';
import { mockEvent, PLAN_ID, PLAYER_NAME, ready } from './fixtures';

for (const theme of ['dark', 'light'] as const) {
  for (const width of [390, 1440]) {
    test(`${theme} ${width}px planner confirms all 17 places using compact native evidence`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const { responses, queryResponses, unexpected } = await mockEvent(page, { role: 'admin' });
      const members = Array.from({ length: 17 }, (_, index) => ({
        entryId: `entry-${index}`,
        playerId: `player-${index}`,
        name: index === 0 ? PLAYER_NAME : `Round robin entrant ${index + 1}`,
        seed: index + 1,
        place: null,
        snapshotRank: null,
        withdrawn: false,
      }));
      const matchRevisionToken = 'a'.repeat(64);
      const view: EventPlanView = {
        plan: {
          id: PLAN_ID,
          name: 'Nemesis · Seventeen-player round robin',
          eventDate: '2026-10-05T08:00:00Z',
          slugPrefix: null,
          status: 'underway',
          softLockedAt: '2026-10-05T08:00:00Z',
          softLockedBy: null,
          bracketMode: 'native',
          structure: 'round_robin',
          historicalAdoption: null,
          upperTargetSize: null,
          poolSize: 17,
          rankingSnapshotAt: null,
          createdAt: '2026-10-04T00:00:00Z',
        },
        entries: members.map((member) => ({
          id: member.entryId,
          sourceLineNumber: member.seed,
          rawInput: member.name,
          cleanedName: member.name,
          companyCode: null,
          playerId: member.playerId,
          playerName: member.name,
          publicName: member.name,
          playerStatus: 'active',
          resolutionMethod: 'manual',
          divisionPreference: 'auto',
          assignedDivision: 'upper',
          snapshotRank: null,
          snapshotScore: null,
          divisionSeed: member.seed,
          currentRank: null,
          currentScore: null,
          lastPlayedDate: null,
          candidates: [],
        })),
        divisions: [
          {
            division: 'upper',
            size: members.length,
            poolCount: 1,
            championship: [],
            consolation: null,
            pools: [
              {
                poolIndex: 0,
                label: 'A',
                members,
                orderStatus: {
                  status: 'ruling_required',
                  reason:
                    'Set wins do not decide a unique full order. Confirm the finishing order.',
                },
                placementRevision: '7',
                matchRevisionToken,
              },
            ],
          },
        ],
        brackets: [],
        issues: { blocking: [], warnings: [] },
      };
      queryResponses.set('admin.eventPlanner.plan', (input) => {
        expect(input).toEqual({ planId: PLAN_ID, revisionEvidence: 'compact' });
        return view;
      });
      responses['admin.eventPlanner.savePoolPlacements'] = { ok: true };
      await page.goto(`/admin/event-planner?plan=${PLAN_ID}&step=pools`);
      const pool = page.locator('.pool-card');
      await expect(pool).toContainText('Set wins do not decide a unique full order.');
      await expect(page.getByRole('heading', { name: 'Championship qualifiers' })).toHaveCount(0);
      const placements = pool.getByRole('combobox');
      await expect(placements).toHaveCount(17);
      const confirm = pool.getByRole('button', { name: 'Confirm pool', exact: true });
      await expect(confirm).toBeDisabled();
      await placements.first().press('Enter');
      const menu = page.getByRole('listbox');
      await expect(menu).toBeVisible();
      await menu.getByRole('option', { name: members[0]!.name, exact: true }).click();
      for (const [index, member] of members.entries())
        if (index !== 0) await chooseOption(placements.nth(index), member.playerId);
      await expect(confirm).toBeEnabled();
      await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
      await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
      await ready(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
          .violations,
      ).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath('large-pool-order.png'), fullPage: true });
      const sent = page.waitForRequest((request) =>
        request.url().includes('admin.eventPlanner.savePoolPlacements'),
      );
      await confirm.press('Enter');
      const request = await sent;
      const body = request.postDataJSON();
      const input = new URL(request.url()).searchParams.has('batch') ? body[0] : body;
      expect(input).toEqual({
        planId: PLAN_ID,
        division: 'upper',
        pools: [
          {
            poolIndex: 0,
            playerIdsInOrder: members.map((m) => m.playerId),
            expectedPlacementRevision: '7',
            expectedMatchRevisionToken: matchRevisionToken,
          },
        ],
      });
      expect(unexpected).toEqual([]);
    });
  }
}
