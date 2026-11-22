import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { chooseOption } from '../test-support/controls';
import type { trpc } from '../src/lib/trpc';
import type { Desk } from '../src/pages/admin/dispatchTypes';
import { mockEvent, PLAN_ID, ready } from './fixtures';

type PreviewInput = Parameters<typeof trpc.eventOps.previewAttendance.query>[0];

async function reviewPage(page: Page, path: string) {
  await ready(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    (
      await new AxeBuilder({ page })
        .include('.ops-page')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path, fullPage: true });
}

const cases = [
  { theme: 'dark', width: 390, mode: 'shared' },
  { theme: 'light', width: 390, mode: 'station' },
  { theme: 'dark', width: 1440, mode: 'station' },
  { theme: 'light', width: 1440, mode: 'shared' },
] as const;

for (const { theme, width, mode } of cases)
  test(`${theme} ${width}px ${mode} no-show preview recovers the exact call and retains the draft`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
    const { overview, responses, queryResponses, mutationResponses, unexpected } = await mockEvent(
      page,
      {
        role: 'admin',
        idle: true,
      },
    );
    const call = overview.matches.find((match) => match.status === 'ready')!;
    const unrelated = overview.matches.find(
      (match) =>
        ![match.player1Id, match.player2Id].some(
          (id) => id === call.player1Id || id === call.player2Id,
        ),
    )!;
    const entrant = overview.entrants.find((item) => item.id === call.player1Id)!;
    const alias = 'Alexandria with a long tournament alias from Western Sydney';
    entrant.name = alias;
    Object.assign(overview.plan, { bracketMode: 'native', drawPaused: false, liveOwned: true });
    overview.reports = [];
    Object.assign(call, {
      label: 'Pool A · Round 1',
      player1Name: alias,
      status: 'playing',
      started: false,
      called: mode === 'shared',
      stationId: mode === 'station' ? overview.stations[0]!.id : null,
      resourceRevision: 12,
    });
    Object.assign(unrelated, { status: 'playing', started: false, called: mode === 'shared' });
    const desk: Desk = {
      mode,
      capacity: 2,
      active: 2,
      overCapacity: 0,
      resourceRevision: 12,
      queueRevision: 0,
      stations: [],
      entrants: [],
      pools: [],
      queue: [call, unrelated].map((match) => ({
        matchId: match.id,
        state: 'called',
        waitingSince: 0,
        downstream: 0,
        reason: 'Awaiting actual play',
        canStart: false,
        canDispatchOrdinary: false,
        eligibleStationIds: [],
        reasons: [],
      })),
    };
    Object.assign(overview, {
      operatorDispatch: desk,
      sharedDispatch: mode === 'shared' ? { active: 2, capacity: 2, overCapacity: 0 } : null,
    });
    responses['eventOps.delivery.status'] = { configured: false };
    let returned = false;
    const previews: PreviewInput[] = [];
    const applications: unknown[] = [];
    const returns: unknown[] = [];
    queryResponses.set('eventOps.previewAttendance', (input) => {
      previews.push(input as PreviewInput);
      return {
        allowed: returned,
        issues: returned ? [] : ['Return this entrant’s untaken call before changing the draw.'],
        ...(returned ? {} : { returnCallMatchIds: [call.id] }),
        warnings: [],
        requiresExternalAcknowledgement: false,
        requiresRedistributionApproval: false,
        relocations: [],
        affectedMatches: [{ id: call.id, label: call.label, status: call.status }],
        addedMatches: 0,
        revisionToken: returned ? 'fresh-review' : 'blocked-review',
      };
    });
    const returnProcedure = mode === 'shared' ? 'eventOps.live.command' : 'eventOps.updateMatch';
    mutationResponses.set(returnProcedure, (input) => {
      returns.push(mode === 'shared' ? (input as { command: unknown }).command : input);
      Object.assign(call, {
        status: 'ready',
        called: false,
        resourceRevision: 13,
        stationId: null,
      });
      desk.queue = desk.queue.filter((row) => row.matchId !== call.id);
      desk.active = 1;
      returned = true;
      return {};
    });
    mutationResponses.set('eventOps.applyAttendance', (input) => {
      applications.push(input);
      return { applied: true };
    });

    await page.goto(`/operate/${PLAN_ID}?view=players`);
    const attendance = page.locator('section.card').filter({
      has: page.getByRole('heading', { name: 'Attendance changes', exact: true }),
    });
    const player = attendance.getByRole('combobox', { name: 'Player', exact: true });
    const reason = attendance.getByRole('textbox', { name: 'Reason' });
    const apply = attendance.getByRole('button', { name: 'Apply this change' });
    const refresh = attendance.getByRole('button', { name: 'Refresh attendance preview' });
    await expect(attendance).toBeVisible();
    await ready(page);
    const action = attendance.getByRole('combobox', { name: 'Change', exact: true });
    await action.evaluate((element) => element.scrollIntoView({ block: 'center' }));
    await chooseOption(action, 'no_show');
    await player.evaluate((element) => element.scrollIntoView({ block: 'center' }));
    await chooseOption(player, entrant.id);
    await reason.fill('Did not arrive');
    const preview = attendance.getByRole('button', { name: 'Preview attendance change' });
    await preview.press('Enter');
    const open = attendance.getByRole('button', { name: /^Open call for/ });
    await expect(open).toHaveCount(1);
    await expect(open).toHaveAccessibleName(new RegExp(alias));
    await expect(apply).toBeDisabled();
    await reviewPage(page, testInfo.outputPath('players-blocked-no-show.png'));

    await open.press('Enter');
    const returnCall = page.locator(`[id="return-call-${call.id}"]`);
    await expect(returnCall).toBeFocused();
    await expect
      .poll(() =>
        returnCall.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return element.contains(
            document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2),
          );
        }),
      )
      .toBe(true);
    expect(returns).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('run-keyboard-focus.png') });
    await reviewPage(page, testInfo.outputPath('run-exact-return-control.png'));
    const [response] = await Promise.all([
      page.waitForResponse(
        (reply) =>
          reply.request().method() === 'POST' &&
          decodeURIComponent(new URL(reply.url()).pathname.replace('/api/trpc/', ''))
            .split(',')
            .includes(returnProcedure),
      ),
      returnCall.press('Enter'),
    ]);
    expect(response.ok()).toBe(true);
    expect(returns).toEqual([
      expect.objectContaining({
        matchId: call.id,
        expectedRevision: call.revision,
        expectedResourceRevision: 12,
        status: 'ready',
      }),
    ]);
    await page.getByRole('tab', { name: 'Players' }).press('Enter');
    await expect(player).toContainText(alias);
    await expect(reason).toHaveValue('Did not arrive');
    await expect(open).toHaveCount(0);
    await expect(apply).toBeDisabled();
    expect(previews).toHaveLength(1);
    expect(applications).toEqual([]);
    await refresh.press('Enter');
    await expect(apply).toBeEnabled();
    await expect(attendance.getByRole('heading', { name: 'Change preview' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(apply).toBeFocused();
    expect(previews).toEqual([previews[0], previews[0]]);
    expect(applications).toEqual([]);
    await reviewPage(page, testInfo.outputPath('players-reviewed-no-show.png'));

    await apply.press('Enter');
    await expect(attendance.getByRole('status')).toContainText('Attendance updated');
    expect(applications).toEqual([
      {
        ...previews[0],
        approveRedistribution: false,
        revisionToken: 'fresh-review',
      },
    ]);

    if (theme === 'light' && width === 1440) {
      await test.step('serve a refreshed preview after roster and settings in the same batch', async () => {
        const input = { ...previews[0], requestId: '9879a1cb-2169-4cff-a0ab-e0ca802f4dcd' };
        const batch = await page.evaluate(
          async ({ planId, input }) => {
            const procedures = [
              'eventOps.attendeeRoster',
              'eventOps.guests.settings',
              'eventOps.previewAttendance',
            ];
            const params = new URLSearchParams({
              batch: '1',
              input: JSON.stringify({ 0: { planId }, 1: { planId }, 2: input }),
            });
            const response = await fetch(`/api/trpc/${procedures.join(',')}?${params}`);
            return response.json();
          },
          { planId: PLAN_ID, input },
        );
        expect(batch).toEqual([
          { result: { data: responses['eventOps.attendeeRoster'] } },
          { result: { data: responses['eventOps.guests.settings'] } },
          {
            result: {
              data: expect.objectContaining({
                allowed: true,
                affectedMatches: [{ id: call.id, label: call.label, status: 'ready' }],
                revisionToken: 'fresh-review',
              }),
            },
          },
        ]);
        expect(previews[2]).toEqual(input);
      });
    }
    expect(unexpected).toEqual([]);
  });
