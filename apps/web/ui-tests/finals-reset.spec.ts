import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Command, Desk } from '../src/pages/admin/dispatchTypes';
import type { trpc } from '../src/lib/trpc';
import type { EventPlanView } from '../src/lib/apiTypes';
import { mockEvent, PLAN_ID, ready } from './fixtures';

type StrengthPreview = Extract<
  Awaited<ReturnType<typeof trpc.eventOps.native.preview.query>>,
  { seedPolicy: 'pool_place_whr_v1' }
>;
const callIssue = 'Return untaken finals calls before resetting their draw.';

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test(`${theme} ${width}px legacy worksheet keeps confirmed places after a withdrawal`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const { responses, unexpected } = await mockEvent(page, { role: 'admin' });
      const names = [
        'Alexandria with a long tournament alias from Western Sydney',
        'Beatrice',
        'Charlie',
        'Drew',
      ];
      const view: EventPlanView = {
        plan: {
          id: PLAN_ID,
          name: 'Nemesis · Legacy finals',
          eventDate: '2026-10-05T08:00:00Z',
          slugPrefix: null,
          status: 'underway',
          softLockedAt: '2026-10-05T08:00:00Z',
          softLockedBy: null,
          bracketMode: 'native',
          historicalAdoption: null,
          upperTargetSize: null,
          poolSize: 4,
          rankingSnapshotAt: null,
          createdAt: '2026-10-04T00:00:00Z',
        },
        entries: names.map((name, index) => ({
          id: `entry-${index}`,
          sourceLineNumber: index + 1,
          rawInput: name,
          cleanedName: name,
          companyCode: null,
          playerId: `player-${index}`,
          playerName: name,
          publicName: name,
          withdrawn: index === 0,
          playerStatus: 'active',
          resolutionMethod: 'manual',
          divisionPreference: 'auto',
          assignedDivision: 'upper',
          snapshotRank: null,
          snapshotScore: null,
          divisionSeed: index + 1,
          currentRank: null,
          currentScore: null,
          lastPlayedDate: null,
          candidates: [],
        })),
        divisions: [
          {
            division: 'upper',
            size: names.length,
            poolCount: 1,
            fixedLegacyFinals: true,
            championship: [],
            consolation: null,
            pools: [
              {
                poolIndex: 0,
                label: 'A',
                orderLockedReason:
                  'Finals already use this pool order. Its confirmed places stay recorded after withdrawals.',
                orderStatus: {
                  status: 'manual',
                  reason: 'Finishing order confirmed by an organiser.',
                },
                members: names.map((name, index) => ({
                  entryId: `entry-${index}`,
                  playerId: `player-${index}`,
                  name,
                  seed: index + 1,
                  place: index + 1,
                  snapshotRank: null,
                  withdrawn: index === 0,
                })),
              },
            ],
          },
        ],
        brackets: [],
        issues: { blocking: [], warnings: [] },
      };
      responses['admin.eventPlanner.plan'] = view;
      await page.goto(`/admin/event-planner?plan=${PLAN_ID}&step=pools`);
      const pool = page.locator('.pool-card').filter({ hasText: 'Pool A' });
      const withdrawn = pool.getByRole('listitem').filter({ hasText: names[0]! });
      await expect(withdrawn).toContainText('Withdrawn');
      await expect(withdrawn).toContainText('1st');
      await expect(pool.getByRole('combobox', { name: '1st place in pool A' })).toBeDisabled();
      await expect(pool.getByRole('button', { name: 'Confirm pool' })).toBeDisabled();
      await expect(page.getByText('Championship qualifiers', { exact: true })).toHaveCount(0);
      await expect(page.getByText('Consolation draw', { exact: true })).toHaveCount(0);
      await expect(page.getByText(/excluded from advancement/)).toHaveCount(0);
      const deskLink = page.getByRole('link', { name: 'event desk', exact: true });
      await expect(deskLink).toHaveAttribute('href', `/admin/event-operations?plan=${PLAN_ID}`);
      await deskLink.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(deskLink).toBeFocused();
      await ready(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.evaluate(() => window.scrollTo(0, 0));
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
      await testInfo.attach('legacy-pool-worksheet', {
        body: await page.screenshot({ fullPage: true }),
        contentType: 'image/png',
      });
      expect(unexpected).toEqual([]);
    });

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test(`${theme} ${width}px finals removal locates a returnable call and refreshes its token`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const { overview, responses, unexpected } = await mockEvent(page, { role: 'admin' });
      Object.assign(overview.plan, { bracketMode: 'native', drawPaused: false });
      const call = overview.matches.find((match) => match.status === 'ready')!;
      Object.assign(call, {
        player1Name: 'Alexandria with a long doubles alias / Captain Falcon from Western Sydney',
        status: 'playing',
        started: false,
        called: true,
        stationId: null,
        nativeBracketId: 'existing-finals',
      });
      const desk: Desk = {
        mode: 'shared',
        capacity: 2,
        active: 1,
        overCapacity: 0,
        resourceRevision: 12,
        queueRevision: 0,
        stations: [],
        entrants: [],
        pools: [],
        queue: [
          {
            matchId: call.id,
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
      Object.assign(overview, { operatorDispatch: desk });
      const preview: StrengthPreview = {
        seedPolicy: 'pool_place_whr_v1',
        existing: true,
        allowed: false,
        issues: [],
        replacing: false,
        resetAllowed: false,
        resetIssues: [callIssue, 'Finals have report history.'],
        resetCallMatchIds: [],
        resetRevisionToken: 'blocked-token',
        revisionToken: 'reviewed-draw',
        poolOrders: [],
        waitingStages: [],
        brackets: [],
      };
      responses['eventOps.native.preview'] = preview;
      const commands: { command: Command; requestId: string }[] = [];
      await page.route('**/api/trpc/eventOps.live.command*', async (route) => {
        const request = route.request();
        const batched = new URL(request.url()).searchParams.has('batch');
        const payload = request.postDataJSON();
        commands.push(batched ? payload[0] : payload);
        Object.assign(call, { status: 'ready', called: false, revision: call.revision + 1 });
        desk.queue = [];
        desk.active = 0;
        Object.assign(preview, {
          allowed: true,
          revisionToken: 'new-draw',
          resetAllowed: true,
          resetIssues: [],
          resetCallMatchIds: [],
          resetRevisionToken: 'refreshed-removal',
        });
        const result = { result: { data: {} } };
        await route.fulfill({ json: batched ? [result] : result });
      });
      const removals: { planId: string; revisionToken: string }[] = [];
      await page.route('**/api/trpc/eventOps.native.reset*', async (route) => {
        const request = route.request();
        const batched = new URL(request.url()).searchParams.has('batch');
        const payload = request.postDataJSON();
        removals.push(batched ? payload[0] : payload);
        const result = { result: { data: { removed: 1 } } };
        await route.fulfill({ json: batched ? [result] : result });
      });

      await page.goto(`/operate/${PLAN_ID}?view=draw`);
      const drawTab = page.getByRole('tab', { name: 'Standings / draw', exact: true });
      const draw = page.getByRole('tabpanel', { name: 'Standings / draw', exact: true });
      const previewButton = draw.getByRole('button', { name: 'Preview finals', exact: true });
      const removal = draw.getByRole('region', { name: 'Finals removal' });
      const remove = removal.getByRole('button', { name: 'Remove unplayed finals' });
      const open = removal.getByRole('button', { name: /^Open call for/ });
      await previewButton.click();
      await expect(removal).toContainText('Finals have report history.');
      await expect(remove).toBeDisabled();
      await expect(open).toHaveCount(0);

      Object.assign(preview, { resetIssues: [callIssue], resetCallMatchIds: [call.id] });
      await previewButton.click();
      await expect(removal).toContainText(callIssue);
      await expect(open).toHaveAccessibleName(new RegExp(call.player1Name!));
      await expect(remove).toBeDisabled();
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
      await removal.screenshot({ path: testInfo.outputPath('finals-removal-blocked.png') });
      await page.screenshot({ path: testInfo.outputPath('draw-with-blocked-removal.png') });
      await open.press('Enter');
      expect(commands).toHaveLength(0);
      const returnCall = page
        .locator(`[data-match-id="${call.id}"]`)
        .getByRole('button', { name: 'Return untaken call' });
      await expect(returnCall).toBeFocused();
      await returnCall.press('Enter');
      await expect(returnCall).toHaveCount(0);
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        requestId: expect.any(String),
        command: {
          kind: 'matchControl',
          matchId: call.id,
          status: 'ready',
          stationId: null,
          expectedResourceRevision: 12,
        },
      });

      await drawTab.click();
      await expect(remove).toBeEnabled();
      await expect(open).toHaveCount(0);
      await expect(draw.getByRole('button', { name: 'Create ready finals' })).toBeDisabled();
      await remove.click();
      await expect(page.getByRole('alertdialog')).toContainText('Pool results will stay recorded.');
      expect(removals).toHaveLength(0);
      await page
        .getByRole('alertdialog')
        .getByRole('button', { name: 'Confirm', exact: true })
        .click();
      await expect
        .poll(() => removals)
        .toEqual([{ planId: PLAN_ID, revisionToken: 'refreshed-removal' }]);
      expect(unexpected).toEqual([]);
    });

for (const mode of ['live', 'legacy_locked', 'legacy_unlocked'] as const)
  test(`${mode} queue reset describes what happens to matches`, async ({ page }) => {
    const { overview, responses, unexpected } = await mockEvent(page, { role: 'admin' });
    Object.assign(overview.plan, {
      liveOwned: mode === 'live',
      softLockedAt: mode === 'legacy_unlocked' ? null : '2026-10-04T00:00:00Z',
    });
    overview.matches = [];
    overview.reports = [];
    overview.withdrawals = [];
    overview.brackets = [];
    responses['eventOps.resetOperations'] = {};
    await page.goto(`/operate/${PLAN_ID}?view=settings`);
    const settings = page.getByRole('tabpanel', { name: 'Settings' });
    await settings.getByRole('button', { name: /^Before play:/ }).click();
    await expect(settings).toContainText(
      mode === 'live'
        ? 'Existing matches and pairings stay in the queue.'
        : /Clear unplayed matches|Clear an unplayed queue/,
    );
    await settings.getByRole('button', { name: 'Reset unplayed queue' }).click();
    const confirmation = page.getByRole('alertdialog');
    await expect(confirmation).toContainText(
      mode === 'live'
        ? 'matches and pairings will stay in place'
        : 'Clear this unplayed match queue?',
    );
    await confirmation.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page.getByRole('status')).toContainText(
      mode === 'live' ? 'Queue setup reset.' : 'Unplayed queue cleared.',
    );
    expect(unexpected).toEqual([]);
  });
