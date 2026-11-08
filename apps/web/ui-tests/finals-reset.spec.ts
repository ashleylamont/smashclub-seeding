import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Command, Desk, Overview } from '../src/pages/admin/dispatchTypes';
import type { trpc } from '../src/lib/trpc';
import type { EventPlanView } from '../src/lib/apiTypes';
import { chooseOption } from '../test-support/controls';
import { mockEvent, PLAN_ID, ready } from './fixtures';

type StrengthPreview = Extract<
  Awaited<ReturnType<typeof trpc.eventOps.native.preview.query>>,
  { seedPolicy: 'pool_place_whr_v1' }
>;
const callIssue = 'Return untaken finals calls before resetting their draw.';

function legacyWorksheet(names: string[]): EventPlanView {
  return {
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
              'The finals draw is in use. Confirmed places stay recorded after withdrawals.',
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
}

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
      const view = legacyWorksheet(names);
      responses['admin.eventPlanner.plan'] = view;
      await page.goto(`/admin/event-planner?plan=${PLAN_ID}&step=pools`);
      const pool = page.locator('.pool-card').filter({ hasText: 'Pool A' });
      const withdrawn = pool.getByRole('listitem').filter({ hasText: names[0]! });
      await expect(withdrawn).toContainText('Withdrawn');
      await expect(withdrawn).toContainText('1st');
      await expect(pool.getByRole('combobox')).toHaveCount(0);
      await expect(pool.getByRole('button', { name: 'Confirm pool' })).toHaveCount(0);
      await expect(pool.getByText('Finishing order confirmed by an organiser.')).toBeVisible();
      await expect(pool.getByText(/Confirmed places stay recorded/)).toBeVisible();
      await expect(page.getByText(/Resolve ties using the event rules/)).toHaveCount(0);
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
      if (theme === 'dark' && width === 390) {
        const upper = view.divisions[0]!;
        const fixed = upper.pools[0]!;
        const extraPool = (label: string, poolIndex: number) => ({
          label,
          poolIndex,
          members: fixed.members.map((member) => ({
            ...member,
            entryId: `${label}-${member.entryId}`,
            playerId: `${label}-${member.playerId}`,
            name: `${member.name} ${label}`,
            withdrawn: false,
            place: null,
          })),
        });
        const pending = extraPool('B', 1);
        const missing = extraPool('C', 2);
        upper.pools.push(pending, {
          ...missing,
          orderLockedReason:
            'The confirmed order is missing. This worksheet cannot restore it after finals used it.',
        });
        upper.poolCount = upper.pools.length;
        upper.size = upper.pools.flatMap(({ members }) => members).length;
        await page.reload();
        await expect(page.getByText(/Resolve ties using the event rules/)).toBeVisible();
        const pendingCard = page.locator('.pool-card').filter({ hasText: 'Pool B' });
        const missingCard = page.locator('.pool-card').filter({ hasText: 'Pool C' });
        await expect(pool.getByRole('combobox')).toHaveCount(0);
        await expect(missingCard.getByText(/The confirmed order is missing/)).toBeVisible();
        await expect(missingCard.getByRole('combobox')).toHaveCount(0);
        await expect(missingCard.getByRole('button', { name: 'Confirm pool' })).toHaveCount(0);
        const confirm = pendingCard.getByRole('button', { name: 'Confirm pool' });
        await expect(confirm).toBeDisabled();
        for (const [i, place] of ['1st', '2nd', '3rd', '4th'].entries())
          await chooseOption(
            pendingCard.getByRole('combobox', { name: `${place} place in pool B` }),
            pending.members[i]!.playerId,
          );
        await expect(confirm).toBeEnabled();
      }
      expect(unexpected).toEqual([]);
    });

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test(`${theme} ${width}px administrator reviews an original legacy pool order before restoring it`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const { responses, queryResponses, unexpected } = await mockEvent(page, { role: 'admin' });
      const names = [
        'Alexandria with a long tournament alias from Western Sydney',
        'Beatrice',
        'Charlie',
        'Drew',
      ];
      const view = legacyWorksheet(names);
      const archived = width === 1440;
      view.plan.status = archived ? 'complete' : 'underway';
      const division = view.divisions[0]!;
      const pool = division.pools[0]!;
      const poolId = '095a046a-6391-4a41-ab13-1d22822269f6';
      const unavailablePoolId = '9495a86a-0a93-4f60-b1a2-68b9995511a3';
      pool.legacyOrderRepairPoolId = poolId;
      pool.orderLockedReason =
        'The confirmed order is missing. Check the journal for the original places.';
      delete pool.orderStatus;
      pool.members.forEach((member) => (member.place = null));
      if (archived && theme === 'light') {
        const other = legacyWorksheet(['Eve', 'Fiona', 'George', 'Haru']);
        view.entries.push(
          ...other.entries.map((entry) => ({
            ...entry,
            id: `other-${entry.id}`,
            playerId: `other-${entry.playerId}`,
          })),
        );
        division.pools.push({
          ...pool,
          label: 'B',
          poolIndex: 1,
          legacyOrderRepairPoolId: unavailablePoolId,
          members: other.divisions[0]!.pools[0]!.members.map((member) => ({
            ...member,
            entryId: `other-${member.entryId}`,
            playerId: `other-${member.playerId}`,
            place: null,
          })),
        });
        division.poolCount = 2;
        division.size = view.entries.length;
      }
      responses['admin.eventPlanner.plan'] = view;
      const order = [2, 1, 3, 0].map((index) => pool.members[index]!);
      let lookups = 0;
      queryResponses.set('eventOps.live.previewLegacyPoolOrderRepair', (input) => {
        if ((input as { poolId: string }).poolId === unavailablePoolId)
          return {
            allowed: false,
            reason: 'This journal is too large for a verified placement review.',
          };
        expect(input).toEqual({ planId: PLAN_ID, poolId });
        lookups++;
        return {
          allowed: true,
          evidence: {
            order: order.map(({ playerId }) => playerId),
            confirmation: {
              source: archived ? 'confirmed' : 'imported',
              id: 18,
              at: Date.parse('2026-10-05T09:00:00Z'),
            },
            withdrawal: {
              id: 21,
              at: Date.parse('2026-10-05T10:00:00Z'),
              playerId: order[3]!.playerId,
            },
          },
          places: order.map(({ name }, index) => ({ place: index + 1, name })),
          expectedSequence: 25 + lookups,
          expectedPoolRevision: 3,
          revisionToken: String(lookups).repeat(64),
        };
      });
      const writes: Record<string, unknown>[] = [];
      const staleFirst = !archived && theme === 'dark';
      const retryFirst = !archived && theme === 'light';
      await page.route('**/api/trpc/eventOps.live.restoreLegacyPoolOrder*', async (route) => {
        const batched = new URL(route.request().url()).searchParams.has('batch');
        const body = route.request().postDataJSON();
        writes.push(batched ? body[0] : body);
        if (writes.length === 1 && retryFirst) return route.abort();
        if (writes.length === 1 && staleFirst) {
          const conflict = {
            error: {
              code: -32009,
              message: 'The event changed since this review. Check the journal again.',
              data: { code: 'CONFLICT', httpStatus: 409 },
            },
          };
          return route.fulfill({ json: batched ? [conflict] : conflict });
        }
        delete pool.legacyOrderRepairPoolId;
        pool.orderLockedReason =
          'The finals draw is in use. Confirmed places stay recorded after withdrawals.';
        order.forEach((member, index) => (member.place = index + 1));
        const result = { result: { data: { sequence: 27 } } };
        return route.fulfill({ json: batched ? [result] : result });
      });

      await page.goto(`/admin/event-planner?plan=${PLAN_ID}&step=pools`);
      const card = page
        .locator('.pool-card')
        .filter({ has: page.getByRole('heading', { name: 'Pool A', exact: true }) });
      const check = card.getByRole('button', {
        name: 'Check journal for original order in Upper Pool A',
      });
      await expect(check).toBeVisible();
      expect(lookups).toBe(0);
      await ready(page);
      await page.screenshot({
        fullPage: true,
        path: testInfo.outputPath('legacy-repair-worksheet.png'),
      });

      if (archived && theme === 'light') {
        const unsupported = page
          .locator('.pool-card')
          .filter({ has: page.getByRole('heading', { name: 'Pool B', exact: true }) });
        const checkOther = unsupported.getByRole('button', {
          name: 'Check journal for original order in Upper Pool B',
        });
        await checkOther.press('Enter');
        const noEvidence = page.getByRole('dialog', { name: 'Upper Pool B · Original order' });
        await expect(
          noEvidence.getByText('This journal is too large for a verified placement review.'),
        ).toBeVisible();
        await expect(
          noEvidence.getByRole('button', { name: 'Restore original order' }),
        ).toHaveCount(0);
        await page.keyboard.press('Escape');
        await expect(checkOther).toBeFocused();
      }

      await check.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Upper Pool A · Original order' });
      await expect(dialog.getByRole('heading', { name: 'Confirmed places' })).toBeFocused();
      await expect(dialog.getByRole('listitem')).toHaveText(order.map(({ name }) => name));
      await expect(dialog).toHaveAccessibleDescription(/finals draw and all recorded results/);
      const restore = dialog.getByRole('button', { name: 'Restore original order', exact: true });
      await expect(restore).toBeDisabled();
      expect(writes).toEqual([]);
      await ready(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath('legacy-repair-review.png'),
      });
      await dialog
        .getByRole('textbox', { name: 'Reason for restoration' })
        .fill('Verified the original journal');
      await restore.press('Enter');
      if (staleFirst) {
        await expect(dialog.getByRole('alert')).toContainText('The event changed');
        await expect(restore).toHaveCount(0);
        await dialog.getByRole('button', { name: 'Check journal again' }).press('Enter');
        await expect(restore).toBeEnabled();
        await restore.press('Enter');
      } else if (retryFirst) {
        const retry = dialog.getByRole('button', { name: 'Retry restoration' });
        await expect(retry).toBeEnabled();
        await expect(
          dialog.getByRole('textbox', { name: 'Reason for restoration' }),
        ).toBeDisabled();
        await retry.press('Enter');
      }
      await expect(dialog).toBeHidden();
      await expect(check).toHaveCount(0);
      await expect(card.getByRole('heading', { name: 'Pool A' })).toBeFocused();
      await expect(card.getByRole('listitem').filter({ hasText: order[0]!.name })).toContainText(
        '1st',
      );
      expect(writes).toHaveLength(staleFirst || retryFirst ? 2 : 1);
      expect(writes.at(-1)).toMatchObject({
        planId: PLAN_ID,
        poolId,
        reason: 'Verified the original journal',
        expectedSequence: staleFirst ? 27 : 26,
        expectedPoolRevision: 3,
      });
      expect(writes.at(-1)).not.toHaveProperty('evidence');
      if (retryFirst) expect(writes[0]).toEqual(writes[1]);
      if (staleFirst) expect(writes[0]!.requestId).not.toBe(writes[1]!.requestId);
      expect(unexpected).toEqual([]);
    });

for (const theme of ['dark', 'light'] as const)
  for (const [width, replaceDraw] of [
    [390, false],
    [1440, false],
    [390, true],
    [1440, true],
  ] as const) {
    const scenario = replaceDraw
      ? 'requires a fresh preview when the whole finals draw was replaced'
      : 'locates a returnable call and refreshes its token';
    test(`${theme} ${width}px finals removal ${scenario}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const { overview, responses, unexpected } = await mockEvent(page, { role: 'admin' });
      Object.assign(overview.plan, { bracketMode: 'native', drawPaused: false });
      const call = overview.matches.find((match) => match.status === 'ready')!;
      const returnedMatchId = call.id;
      const division = call.division === 'lower' ? 'lower' : 'upper';
      Object.assign(call, {
        player1Name: 'Alexandria with a long doubles alias / Captain Falcon from Western Sydney',
        status: 'playing',
        started: false,
        called: true,
        stationId: null,
        nativeBracketId: 'existing-finals',
      });
      if (replaceDraw) {
        Object.assign(call, {
          label: 'Lower championship final',
          stage: 'main',
          poolIndex: null,
          nativeRound: 1,
          nativeSlot: 0,
        });
        Object.assign(
          overview.entrants.find(({ id }) => id === call.player1Id)!,
          {
            name: call.player1Name,
          },
        );
        overview.nativeBrackets = [
          {
            id: call.nativeBracketId!,
            division,
            stage: 'main',
            entrantIds: [call.player1Id!, call.player2Id!],
            complete: false,
            winnerId: null,
            standings: [],
          },
        ];
      }
      const originalPair = `${call.player1Name} vs ${call.player2Name}`;
      const replacementPair = `${call.player2Name} vs ${call.player1Name}`;
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
        resetBracketIds: [call.nativeBracketId!],
        divisionResets: [],
        revisionToken: 'reviewed-draw',
        poolOrders: [],
        waitingStages: [],
        brackets: replaceDraw
          ? [
              {
                id: call.nativeBracketId!,
                division,
                stage: 'main',
                entrantIds: [call.player1Id!, call.player2Id!],
                alreadyDrawn: true,
                roundOne: [{ player1Id: call.player1Id, player2Id: call.player2Id }],
                previewMatches: [],
              },
            ]
          : [],
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
        if (replaceDraw) {
          const replacementId = 'replacement-finals';
          const bracket = preview.brackets[0]!;
          preview.resetBracketIds = [replacementId];
          preview.brackets = [
            {
              ...bracket,
              id: replacementId,
              roundOne: [{ player1Id: call.player2Id, player2Id: call.player1Id }],
            },
          ];
          overview.nativeBrackets[0]!.id = replacementId;
          Object.assign(call, {
            id: 'replacement-final-match',
            nativeBracketId: replacementId,
            player1Id: call.player2Id,
            player2Id: call.player1Id,
            player1Name: call.player2Name,
            player2Name: call.player1Name,
          });
        }
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
          matchId: returnedMatchId,
          status: 'ready',
          stationId: null,
          expectedResourceRevision: 12,
        },
      });

      await drawTab.click();
      if (replaceDraw) {
        await expect(removal).toContainText('The selected draw changed. Preview finals again.');
        await expect(remove).toBeDisabled();
        await expect(draw.getByText(originalPair, { exact: true })).toBeVisible();
        expect(removals).toEqual([]);
        await ready(page);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
        expect((await new AxeBuilder({ page }).include('.ops-page').analyze()).violations).toEqual(
          [],
        );
        await page.evaluate(() => scrollTo(0, 0));
        await page.screenshot({
          path: testInfo.outputPath('whole-finals-stale-preview.png'),
          fullPage: true,
        });
        await removal.screenshot({ path: testInfo.outputPath('whole-finals-stale-controls.png') });

        preview.allowed = false;
        const { resetBracketIds: _ids, ...unidentifiedPreview } = preview;
        responses['eventOps.native.preview'] = unidentifiedPreview;
        await previewButton.press('Enter');
        await expect(removal).toContainText('Preview finals again before removing this draw.');
        await expect(remove).toBeDisabled();
        expect(removals).toEqual([]);

        responses['eventOps.native.preview'] = preview;
        await previewButton.press('Enter');
        await expect(draw.getByText(replacementPair, { exact: true })).toBeVisible();
      }
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
  }

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

const scopedRemovalCases = [
  { theme: 'dark', width: 390, mode: 'shared', change: null },
  { theme: 'light', width: 390, mode: 'station', change: null },
  { theme: 'dark', width: 1440, mode: 'station', change: 'removed' },
  { theme: 'light', width: 1440, mode: 'shared', change: 'replaced' },
] as const;

for (const { theme, width, mode, change } of scopedRemovalCases)
  test(`${theme} ${width}px ${mode} reviews and removes just the Upper finals`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
    const { overview, responses, unexpected } = await mockEvent(page, {
      role: 'admin',
      idle: true,
    });
    Object.assign(overview.plan, {
      bracketMode: 'native',
      drawPaused: false,
      liveOwned: true,
      structure: 'dual_division',
    });
    const call = overview.matches.find(
      (match) => match.division === 'upper' && match.status === 'ready',
    )!;
    const station = mode === 'station' ? overview.stations[0]! : null;
    const alias = 'Alexandria with a long tournament alias from Western Sydney';
    const upperScope = {
      division: 'upper' as const,
      bracketIds: ['upper-main', 'upper-consolation'],
    };
    const lowerScope = { division: 'lower' as const, bracketIds: ['lower-main'] };
    Object.assign(
      overview.entrants.find(({ id }) => id === call.player1Id)!,
      { name: alias },
    );
    Object.assign(call, {
      player1Name: alias,
      label: 'Upper championship final',
      status: 'playing',
      started: false,
      called: mode === 'shared',
      stationId: station?.id ?? null,
      resourceRevision: 12,
      nativeBracketId: upperScope.bracketIds[0],
      stage: 'main',
      poolIndex: null,
      nativeRound: 1,
      nativeSlot: 0,
    });
    if (station) Object.assign(station, { currentMatchId: call.id, status: 'occupied' });
    const [lowerFirst, lowerSecond] = overview.entrants.slice(-2);
    const lowerFinal = {
      ...call,
      id: 'recorded-lower-final',
      nativeBracketId: lowerScope.bracketIds[0]!,
      nativeRound: 1,
      nativeSlot: 0,
      parent1MatchId: null,
      parent2MatchId: null,
      poolIndex: null,
      division: 'lower' as const,
      label: 'Lower championship final',
      status: 'complete' as const,
      stationId: null,
      called: false,
      started: true,
      outcome: 'played' as const,
      score1: 2,
      score2: 1,
      player1Id: lowerFirst!.id,
      player1Name: lowerFirst!.name,
      player2Id: lowerSecond!.id,
      player2Name: lowerSecond!.name,
      winnerId: lowerFirst!.id,
    };
    Object.assign(overview, { matches: [...overview.matches, lowerFinal] });
    const desk: Desk = {
      mode,
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
          reason: 'Awaiting actual play',
          canStart: false,
          canDispatchOrdinary: false,
          eligibleStationIds: [],
          reasons: [],
        },
      ],
    };
    Object.assign(overview, {
      operatorDispatch: desk,
      sharedDispatch: mode === 'shared' ? { active: 1, capacity: 2, overCapacity: 0 } : null,
    });
    const upper = {
      scope: upperScope,
      revisionToken: 'upper-call-review',
      resetAllowed: false,
      resetIssues: [callIssue],
      resetCallMatchIds: [call.id],
    };
    const playedIssue = 'Finals have actual play and cannot be reset.';
    const lower = {
      scope: lowerScope,
      revisionToken: 'lower-played-review',
      resetAllowed: false,
      resetIssues: [playedIssue],
      resetCallMatchIds: [],
    };
    const preview: StrengthPreview = {
      seedPolicy: 'pool_place_whr_v1',
      existing: true,
      allowed: false,
      issues: [],
      replacing: false,
      resetAllowed: false,
      resetIssues: [playedIssue, callIssue],
      resetCallMatchIds: [],
      resetRevisionToken: 'blocked-global-review',
      resetBracketIds: [...upperScope.bracketIds, ...lowerScope.bracketIds].sort(),
      divisionResets: [upper, lower],
      revisionToken: 'draw-preview',
      poolOrders: [],
      waitingStages: [],
      brackets: [
        {
          id: upperScope.bracketIds[0]!,
          division: 'upper',
          stage: 'main',
          entrantIds: [call.player1Id!, call.player2Id!],
          alreadyDrawn: true,
          roundOne: [{ player1Id: call.player1Id, player2Id: call.player2Id }],
          previewMatches: [],
        },
        {
          id: upperScope.bracketIds[1]!,
          division: 'upper',
          stage: 'consolation',
          entrantIds: [call.player2Id!],
          alreadyDrawn: true,
          roundOne: [],
          previewMatches: [],
        },
        {
          id: lowerScope.bracketIds[0]!,
          division: 'lower',
          stage: 'main',
          entrantIds: [lowerFinal.player1Id, lowerFinal.player2Id],
          alreadyDrawn: true,
          roundOne: [{ player1Id: lowerFinal.player1Id, player2Id: lowerFinal.player2Id }],
          previewMatches: [],
        },
      ],
    };
    const nativeBrackets: Overview['nativeBrackets'] = preview.brackets.map(
      ({ id, division, stage, entrantIds }) => ({
        id,
        division,
        stage,
        entrantIds,
        eventPlanId: PLAN_ID,
        createdAt: '2026-10-04T00:00:00Z',
        complete: id !== upperScope.bracketIds[0],
        winnerId:
          division === 'lower'
            ? lowerFinal.winnerId
            : entrantIds.length === 1
              ? entrantIds[0]!
              : null,
        standings: [],
      }),
    );
    Object.assign(overview, { nativeBrackets });
    responses['eventOps.native.preview'] = preview;
    const returnPath = `/api/trpc/eventOps.${mode === 'shared' ? 'live.command' : 'updateMatch'}`;
    const returned: object[] = [];
    await page.route(`**${returnPath}*`, async (route) => {
      const batched = new URL(route.request().url()).searchParams.has('batch');
      const body = route.request().postDataJSON();
      const input = batched ? body[0] : body;
      returned.push(mode === 'shared' ? input.command : input);
      Object.assign(call, { status: 'ready', started: false, called: false, stationId: null });
      if (station) Object.assign(station, { currentMatchId: null, status: 'free' });
      desk.queue = [];
      desk.active = 0;
      Object.assign(upper, {
        resetAllowed: true,
        resetIssues: [],
        resetCallMatchIds: [],
        revisionToken: 'upper-returned-review',
      });
      if (change) {
        preview.resetAllowed = true;
        preview.resetIssues = [];
        preview.resetRevisionToken = 'allowed-global-review';
        preview.divisionResets =
          change === 'removed'
            ? [lower]
            : [
                {
                  ...upper,
                  scope: { ...upperScope, bracketIds: ['replacement-upper-main'] },
                  revisionToken: 'replacement-review',
                },
                lower,
              ];
      }
      const result = { result: { data: {} } };
      await route.fulfill({ json: batched ? [result] : result });
    });
    const removals: object[] = [];
    await page.route('**/api/trpc/eventOps.native.reset*', async (route) => {
      const batched = new URL(route.request().url()).searchParams.has('batch');
      const body = route.request().postDataJSON();
      removals.push(batched ? body[0] : body);
      if (removals.length === 1 && !change) {
        await route.abort();
        return;
      }
      Object.assign(overview, {
        nativeBrackets: nativeBrackets.filter(({ division }) => division !== 'upper'),
      });
      overview.matches = overview.matches.filter(
        (match) => !upperScope.bracketIds.includes(match.nativeBracketId ?? ''),
      );
      const result = { result: { data: { removed: 2 } } };
      await route.fulfill({ json: batched ? [result] : result });
    });

    await page.goto(`/operate/${PLAN_ID}?view=draw`);
    const drawTab = page.getByRole('tab', { name: 'Standings / draw', exact: true });
    const draw = page.getByRole('tabpanel', { name: 'Standings / draw', exact: true });
    const previewButton = draw.getByRole('button', { name: 'Preview finals', exact: true });
    const removal = draw.getByRole('region', { name: 'Finals removal' });
    const scope = removal.getByRole('combobox', { name: 'Finals to remove' });
    const removeUpper = removal.getByRole('button', { name: 'Remove unplayed Upper finals' });
    const open = removal.getByRole('button', { name: /^Open call for/ });
    await previewButton.press('Enter');
    await expect(removal.getByRole('button', { name: 'Remove unplayed finals' })).toBeDisabled();
    await chooseOption(scope, 'lower');
    await expect(
      removal.getByRole('button', { name: 'Remove unplayed Lower finals' }),
    ).toBeDisabled();
    await expect(removal).toContainText(playedIssue);
    await expect(open).toHaveCount(0);

    await scope.press('Enter');
    await page.getByRole('option', { name: 'Upper finals only' }).press('Enter');
    await expect(removeUpper).toBeDisabled();
    await expect(open).toHaveAccessibleName(new RegExp(alias));
    const published = draw.getByRole('region', { name: 'Tournament draw', exact: true });
    await expect(published.getByRole('heading', { name: 'lower · Championship' })).toBeVisible();
    await expect(published).toContainText(`Winner · ${lowerFirst!.name}`);
    await ready(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    expect((await new AxeBuilder({ page }).include('.ops-page').analyze()).violations).toEqual([]);
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({
      path: testInfo.outputPath('scoped-finals-return-required.png'),
      fullPage: true,
    });
    await removal.screenshot({ path: testInfo.outputPath('scoped-finals-controls.png') });

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
    expect(returned).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('scoped-finals-return-focus.png') });
    const [reply] = await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === returnPath),
      returnCall.press('Enter'),
    ]);
    expect(reply.ok()).toBe(true);
    expect(returned).toEqual([
      expect.objectContaining({
        matchId: call.id,
        expectedRevision: call.revision,
        expectedResourceRevision: 12,
        status: 'ready',
      }),
    ]);
    await drawTab.press('Enter');
    if (change) {
      await expect(removal).toContainText('The selected draw changed. Preview finals again.');
      await expect(removeUpper).toBeDisabled();
      expect(removals).toEqual([]);
      // A fresh review may select the replacement but the earlier review cannot.
      preview.divisionResets = [upper, lower];
      await previewButton.press('Enter');
      await chooseOption(scope, 'upper');
    }
    await expect(removeUpper).toBeEnabled();
    await expect(open).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath('scoped-finals-reviewed.png'),
      fullPage: true,
    });
    const dialog = page.getByRole('alertdialog');
    const confirm = dialog.getByRole('button', { name: 'Confirm', exact: true });
    await removeUpper.press('Enter');
    await expect(dialog).toContainText('Pool results and the other division will stay recorded.');
    await page.screenshot({ path: testInfo.outputPath('scoped-finals-confirmation.png') });
    expect(removals).toEqual([]);
    await confirm.press('Enter');
    if (!change) {
      await expect(draw.getByRole('alert')).toBeVisible();
      await removeUpper.press('Enter');
      await confirm.press('Enter');
    }
    await expect(draw.getByRole('status')).toContainText('Unplayed Upper finals removed.');
    await expect(published.getByRole('heading', { name: 'lower · Championship' })).toBeVisible();
    await expect(published.getByRole('heading', { name: 'upper · Championship' })).toHaveCount(0);
    expect(removals).toEqual(
      Array.from({ length: change ? 1 : 2 }, () => ({
        planId: PLAN_ID,
        scope: upperScope,
        revisionToken: 'upper-returned-review',
        requestId: expect.any(String),
      })),
    );
    if (!change) expect(removals[1]).toEqual(removals[0]);
    expect(unexpected).toEqual([]);
  });
