import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { chooseOption } from '../test-support/controls';
import type { Desk } from '../src/pages/admin/dispatchTypes';
import { mockEvent, PLAN_ID, ready } from './fixtures';

for (const [location, theme, width] of [
  ['source', 'dark', 390],
  ['source', 'light', 390],
  ['destination', 'dark', 1440],
  ['destination', 'light', 1440],
] as const) {
  test(`two-player redistribution opens the guarded Return action for an untaken ${location} call in ${theme}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
    const fixture = await mockEvent(page, { role: 'player', idle: true });
    Object.assign(fixture.overview.plan, {
      name: 'Redistribution rehearsal',
      bracketMode: 'native',
      competitionFormat: 'singles',
      structure: 'dual_division',
      liveOwned: true,
    });
    const upperMatches = fixture.overview.matches.filter(
      ({ division, status, started }) => division === 'upper' && status === 'ready' && !started,
    );
    const sourceMatch = upperMatches.find(({ poolIndex }) => poolIndex === 1)!;
    const destinationMatch = upperMatches.find(({ poolIndex }) => poolIndex === 0)!;
    const called = location === 'source' ? sourceMatch : destinationMatch;
    Object.assign(called, {
      status: 'playing',
      started: false,
      stationId: null,
      calledAt: '2026-10-04T00:00:00Z',
      player1Name: 'Long tournament alias in the affected pool',
    });
    const desk: Desk = {
      mode: 'shared',
      capacity: 2,
      active: 1,
      overCapacity: 0,
      resourceRevision: fixture.overview.settings.resourceRevision,
      queueRevision: 0,
      stations: [],
      entrants: [],
      pools: [],
      queue: [
        {
          matchId: called.id,
          state: 'called',
          waitingSince: 0,
          downstream: 0,
          reason: 'Waiting time, then draw order',
          canStart: false,
          canDispatchOrdinary: false,
          eligibleStationIds: [],
          reasons: [],
        },
      ],
    };
    Object.assign(fixture.overview, {
      operatorDispatch: desk,
      sharedDispatch: { active: 1, capacity: 2, overCapacity: 0 },
    });
    const cases = [sourceMatch.player1Id!, sourceMatch.player2Id!].map((playerId) => ({
      playerId,
      fromPoolIndex: sourceMatch.poolIndex,
      toPoolIndex: destinationMatch.poolIndex,
    }));
    let needsReturn = true;
    const returned: unknown[] = [];
    const reviewInputs: unknown[] = [];
    fixture.responses['eventOps.delivery.status'] = { configured: false };
    fixture.queryResponses.set('eventOps.previewAttendance', (input) => {
      reviewInputs.push(input);
      return {
        allowed: !needsReturn,
        issues: needsReturn ? ['Return the untaken call, then refresh this preview.'] : [],
        ...(needsReturn && { returnCallMatchIds: [called.id] }),
        warnings: [],
        requiresExternalAcknowledgement: false,
        requiresRedistributionApproval: !needsReturn,
        relocations: needsReturn ? [] : cases,
        affectedMatches: [
          { id: sourceMatch.id, label: sourceMatch.label, status: sourceMatch.status },
        ],
        division: 'upper',
        poolSize: 2,
        poolIndex: 1,
        addedMatches: 0,
        revisionToken: needsReturn ? 'before-return' : 'after-return',
      };
    });
    await page.route('**/api/trpc/eventOps.live.command*', async (route) => {
      const batched = new URL(route.request().url()).searchParams.has('batch');
      const body = route.request().postDataJSON();
      returned.push(batched ? body[0] : body);
      needsReturn = false;
      Object.assign(called, { status: 'ready', calledAt: null });
      desk.queue = [];
      desk.active = 0;
      desk.resourceRevision++;
      const response = { result: { data: { status: 'approved' } } };
      await route.fulfill({ json: batched ? [response] : response });
    });
    await page.goto(`/operate/${PLAN_ID}?view=players`);
    const attendance = page.locator('section.card').filter({
      has: page.getByRole('heading', { name: 'Attendance changes', exact: true }),
    });
    const change = attendance.getByRole('combobox', { name: 'Change', exact: true });
    const player = attendance.getByRole('combobox', { name: 'Player', exact: true });
    const inspect = attendance.getByRole('button', { name: 'Preview attendance change' });
    const reason = attendance.getByLabel('Reason', { exact: true });
    await expect(attendance).toBeVisible();
    await ready(page);
    await change.evaluate((element) => element.scrollIntoView({ block: 'center' }));
    await chooseOption(change, 'redistribute');
    await chooseOption(player, sourceMatch.player1Id!);
    await reason.fill('Move the two-player pool together');
    await inspect.press('Enter');
    const preview = attendance.locator('.ops-attendance-preview');
    const apply = preview.getByRole('button', { name: 'Apply this change' });
    await expect(
      preview.getByText('Return the untaken call, then refresh this preview.'),
    ).toBeVisible();
    const openCall = preview.getByRole('button', { name: /^Open call for/ });
    await expect(openCall).toHaveCount(1);
    await expect(openCall).toHaveAccessibleName(/Long tournament alias in the affected pool/);
    await expect(apply).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    const audit = await new AxeBuilder({ page })
      .include('.ops-page')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(audit.violations).toEqual([]);
    await page.screenshot({ fullPage: true, path: testInfo.outputPath('players-desk.png') });
    await preview.screenshot({ path: testInfo.outputPath('blocked-redistribution.png') });

    await openCall.press('Enter');
    expect(returned).toHaveLength(0);
    const returnCall = page.locator(`[id="return-call-${called.id}"]`);
    await expect(returnCall).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath('guarded-return.png') });
    const oldResources = desk.resourceRevision;
    await returnCall.press('Enter');
    await expect.poll(() => returned.length).toBe(1);
    expect(returned[0]).toMatchObject({
      command: {
        kind: 'matchControl',
        matchId: called.id,
        expectedRevision: called.revision,
        expectedResourceRevision: oldResources,
        status: 'ready',
        stationId: null,
        onlyIfUntaken: true,
      },
    });
    await page.getByRole('tab', { name: 'Players', exact: true }).press('Enter');
    await expect(reason).toHaveValue('Move the two-player pool together');
    await expect(apply).toBeDisabled();
    await preview.getByRole('button', { name: 'Refresh attendance preview' }).press('Enter');
    await expect(preview.getByRole('heading', { name: 'Change preview' })).toBeFocused();
    await expect(preview.getByText(/Pool B → Pool A/)).toHaveCount(2);
    const approval = preview.getByRole('checkbox', { name: /I approve moving these players/ });
    await expect(approval).not.toBeChecked();
    await expect(apply).toBeDisabled();
    await approval.press('Space');
    await expect(apply).toBeEnabled();
    await preview.screenshot({
      path: testInfo.outputPath('redistribution-after-return.png'),
    });
    expect(reviewInputs).toHaveLength(2);
    expect(fixture.unexpected).toEqual([]);
  });
}
