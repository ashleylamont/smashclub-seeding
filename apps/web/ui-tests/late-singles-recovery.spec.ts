import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { chooseOption } from '../test-support/controls';
import type { Desk } from '../src/pages/admin/dispatchTypes';
import { mockEvent, PLAN_ID, ready } from './fixtures';

const late = {
  id: 'late-singles',
  name: 'Willa with a long late-arrival alias',
  companyCode: null,
};
const reason = 'Arrived before the called players started';

for (const theme of ['dark', 'light'] as const) {
  for (const width of [390, 1440]) {
    test(`late singles returns the affected call and refreshes at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const fixture = await mockEvent(page, { role: 'player', idle: true });
      Object.assign(fixture.overview.plan, {
        name: 'Late singles rehearsal',
        bracketMode: 'native',
        competitionFormat: 'singles',
        structure: 'round_robin_finals',
        liveOwned: true,
      });
      const [called, unrelated] = fixture.overview.matches.filter(
        ({ status }) => status === 'ready',
      );
      expect(called).toBeDefined();
      expect(unrelated).toBeDefined();
      Object.assign(called!, {
        player1Name: 'Alex with a long tournament alias from Western Sydney',
      });
      Object.assign(unrelated!, { player1Name: 'Other unaffected pool call' });
      for (const match of [called!, unrelated!])
        Object.assign(match, { status: 'playing', started: false, stationId: null });
      const desk: Desk = {
        mode: 'shared',
        capacity: 2,
        active: 2,
        overCapacity: 0,
        resourceRevision: fixture.overview.settings.resourceRevision,
        queueRevision: 0,
        stations: [],
        entrants: [],
        pools: [],
        queue: [called!, unrelated!].map((match) => ({
          matchId: match.id,
          state: 'called',
          waitingSince: 0,
          downstream: 0,
          reason: 'Waiting time, then draw order',
          canStart: false,
          canDispatchOrdinary: false,
          eligibleStationIds: [],
          reasons: [],
        })),
      };
      Object.assign(fixture.overview, {
        operatorDispatch: desk,
        sharedDispatch: { active: 2, capacity: 2, overCapacity: 0 },
      });
      fixture.responses['eventOps.delivery.status'] = { configured: false };
      fixture.responses['public.searchPlayers'] = [late];
      fixture.responses['eventOps.applyAttendance'] = {
        applied: true,
        addedMatches: 4,
        affectedMatches: 0,
      };
      const reviewed: unknown[] = [];
      let needsReturn = true;
      fixture.queryResponses.set('eventOps.previewAttendance', (input) => {
        reviewed.push(input);
        return {
          allowed: !needsReturn,
          issues: needsReturn
            ? ['Return the untaken call in Pool A, then refresh this preview.']
            : [],
          ...(needsReturn && { returnCallMatchIds: [called!.id] }),
          warnings: [],
          requiresExternalAcknowledgement: false,
          requiresRedistributionApproval: false,
          relocations: [],
          affectedMatches: [],
          division: 'upper',
          poolSize: needsReturn ? 0 : 4,
          poolIndex: needsReturn ? null : 0,
          addedMatches: needsReturn ? 0 : 4,
          revisionToken: needsReturn ? 'before-return' : 'after-return',
        };
      });
      const returned: unknown[] = [];
      await page.route('**/api/trpc/eventOps.live.command*', async (route) => {
        const batched = new URL(route.request().url()).searchParams.has('batch');
        const body = route.request().postDataJSON();
        returned.push(batched ? body[0] : body);
        needsReturn = false;
        Object.assign(called!, { status: 'ready', calledAt: null });
        desk.queue = desk.queue.filter(({ matchId }) => matchId !== called!.id);
        desk.active--;
        desk.resourceRevision++;
        const response = { result: { data: { status: 'approved' } } };
        await route.fulfill({ json: batched ? [response] : response });
      });

      await page.goto(`/operate/${PLAN_ID}?view=players`);
      const attendance = page.locator('section.card').filter({
        has: page.getByRole('heading', { name: 'Attendance changes', exact: true }),
      });
      await attendance.getByLabel('Find player by public alias').fill('Willa');
      await chooseOption(
        attendance.getByRole('combobox', { name: 'Player', exact: true }),
        late.id,
      );
      await attendance.getByLabel('Reason', { exact: true }).fill(reason);
      await attendance.getByRole('button', { name: 'Preview attendance change' }).press('Enter');
      const preview = attendance.locator('.ops-attendance-preview');
      const apply = preview.getByRole('button', { name: 'Apply this change' });
      await expect(apply).toBeDisabled();
      await expect(preview.getByText(/new match/)).toHaveCount(0);
      const openCall = preview.getByRole('button', { name: /^Open call for/ });
      await expect(openCall).toHaveCount(1);
      await expect(openCall).toHaveAccessibleName(/Alex with a long tournament alias/);
      await expect(preview.getByText('Other unaffected pool call')).toHaveCount(0);
      await ready(page);
      await preview.screenshot({ path: testInfo.outputPath('late-singles-untaken-call.png') });

      const beforeReturnRevision = desk.resourceRevision;
      await openCall.press('Enter');
      expect(returned).toHaveLength(0);
      const returnCall = page.locator(`[id="return-call-${called!.id}"]`);
      await expect(returnCall).toBeFocused();
      await returnCall.press('Enter');
      await expect.poll(() => returned.length).toBe(1);
      expect(returned[0]).toMatchObject({
        command: {
          kind: 'matchControl',
          matchId: called!.id,
          expectedRevision: called!.revision,
          expectedResourceRevision: beforeReturnRevision,
          status: 'ready',
          stationId: null,
          onlyIfUntaken: true,
        },
      });

      await page.getByRole('tab', { name: 'Players', exact: true }).press('Enter');
      const refresh = preview.getByRole('button', { name: 'Refresh attendance preview' });
      await expect(
        preview.getByText('Refresh the preview before applying this change.'),
      ).toBeVisible();
      await expect(apply).toBeDisabled();
      await expect(attendance.getByLabel('Reason', { exact: true })).toHaveValue(reason);
      await refresh.press('Enter');
      await expect(preview.getByRole('heading', { name: 'Change preview' })).toBeFocused();
      await expect(
        preview.getByText('4 new match(es) · 0 affected existing match(es)'),
      ).toBeVisible();
      await expect(apply).toBeEnabled();
      expect(reviewed).toEqual([
        expect.objectContaining({ action: 'add', playerId: late.id, reason }),
        reviewed[0],
      ]);

      await ready(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(
        (
          await new AxeBuilder({ page })
            .include('.ops-page')
            .withTags(['wcag2a', 'wcag2aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      await preview.screenshot({ path: testInfo.outputPath('late-singles-ready.png') });
      await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
      await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
      await page.screenshot({
        path: testInfo.outputPath('late-singles-full-route.png'),
        fullPage: true,
      });
      await page.keyboard.press('Tab');
      await expect(apply).toBeFocused();
      const posted = page.waitForRequest(
        (request) =>
          request.method() === 'POST' && request.url().includes('eventOps.applyAttendance'),
      );
      await apply.press('Enter');
      const body = (await posted).postDataJSON();
      expect(body[0] ?? body).toMatchObject({
        ...(reviewed[0] as object),
        revisionToken: 'after-return',
      });
      await expect(attendance.getByRole('status')).toContainText('Attendance updated');
      expect(fixture.unexpected).toEqual([]);
    });
  }
}
