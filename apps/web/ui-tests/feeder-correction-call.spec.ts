import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mockEvent, PLAN_ID, ready, type FixtureOptions } from './fixtures';
import type { Desk } from '../src/pages/admin/dispatchTypes';

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test(`reviews a frozen pool score at ${width}px in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const options: FixtureOptions = {
        role: 'admin',
        history: [
          {
            entries: [
              {
                id: 'act:52',
                eventName: 'DecisionRecordedV6',
                version: 52,
                at: '2026-10-03T23:59:00.000Z',
                actor: 'Organiser',
                source: 'operator',
                category: 'scores',
                title: 'Score recorded',
                summary: 'Pool score',
                matchId: '',
                details: {},
              },
            ],
            nextCursor: null,
          },
        ],
      };
      const { overview, unexpected } = await mockEvent(page, options);
      const match = overview.matches.find(
        (row) => row.status === 'complete' && row.stage === 'group',
      )!;
      options.history![0]!.entries[0]!.matchId = match.id;
      const revision = match.revision;
      Object.assign(overview.plan, { bracketMode: 'native', drawPaused: false, liveOwned: true });
      Object.assign(match, {
        label: 'Recorded pool set',
        player1Name: 'Alexandria with a long tournament alias from Western Sydney',
        reviewPoolGames: true,
        score1: 2,
        score2: 0,
        winnerId: match.player1Id,
        outcome: 'played',
      });
      const previews: object[] = [];
      const submissions: { requestId: string; command: { poolGameCorrectionToken: string } }[] = [];
      let revisionToken = 'a'.repeat(64);
      await page.route('**/api/trpc/eventOps.live.previewPoolGameCorrection*', async (route) => {
        const params = new URL(route.request().url()).searchParams;
        const input = JSON.parse(params.get('input')!);
        previews.push(params.has('batch') ? input[0] : input);
        const result = {
          result: { data: { previousScore: [match.score1, match.score2], revisionToken } },
        };
        await route.fulfill({ json: params.has('batch') ? [result] : result });
      });
      await page.route('**/api/trpc/eventOps.live.command*', async (route) => {
        const batched = new URL(route.request().url()).searchParams.has('batch');
        const body = route.request().postDataJSON();
        submissions.push(batched ? body[0] : body);
        let conflict: string | undefined;
        switch (submissions.length) {
          case 1:
            revisionToken = 'b'.repeat(64);
            conflict = 'Pool evidence changed. Review the score correction again.';
            break;
          case 2:
            Object.assign(match, { score2: 1, revision: revision + 1 });
            await route.abort();
            return;
          case 4:
            Object.assign(match, { score1: 3, revision: revision + 2 });
            conflict = 'This match changed. Refresh and try again.';
            break;
        }
        const result = conflict
          ? {
              error: {
                message: conflict,
                code: -32009,
                data: { code: 'CONFLICT', httpStatus: 409 },
              },
            }
          : { result: { data: {} } };
        await route.fulfill({ json: batched ? [result] : result });
      });
      await page.goto(`/operate/${PLAN_ID}?view=history`);
      await page.getByRole('button', { name: 'Open match', exact: true }).click();
      const card = page.locator('article.ops-match:visible').filter({ hasText: match.label });
      await card.getByRole('button', { name: 'Correct score' }).click();
      await card.getByRole('spinbutton').last().fill('1');
      const reviewButton = card.getByRole('button', { name: 'Review correction' });
      await reviewButton.press('Enter');
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toContainText('Correct 2–0 to 2–1?');
      await expect(dialog).toContainText(
        'The winner, confirmed pool places and finals draw stay as recorded.',
      );
      await expect(dialog).toContainText('Ratings use the corrected games after publication.');
      await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
      expect(submissions).toHaveLength(0);
      await ready(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
          .violations,
      ).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath('frozen-pool-correction.png') });
      await dialog.getByRole('button', { name: 'Cancel' }).press('Enter');
      await expect(reviewButton).toBeFocused();
      expect(submissions).toHaveLength(0);
      await reviewButton.press('Enter');
      await dialog.getByRole('button', { name: 'Confirm', exact: true }).press('Enter');
      await expect(
        page.getByText('Pool evidence changed. Review the score correction again.'),
      ).toBeVisible();
      await expect(reviewButton).toBeEnabled();
      await expect(card.getByRole('button', { name: 'Retry correction' })).toHaveCount(0);
      await reviewButton.press('Enter');
      await expect(dialog).toContainText('Correct 2–0 to 2–1?');
      await dialog.getByRole('button', { name: 'Confirm', exact: true }).press('Enter');
      await expect(
        card.locator('.ops-contestant').last().getByText('1', { exact: true }),
      ).toBeVisible();
      await expect(card.getByRole('button', { name: 'Retry correction' })).toBeEnabled();
      await card.getByRole('button', { name: 'Retry correction' }).click();
      await expect(
        page.getByRole('status').filter({ hasText: /Pool score corrected/ }),
      ).toBeVisible();
      const input = {
        planId: PLAN_ID,
        matchId: match.id,
        expectedRevision: revision,
        score1: 2,
        score2: 1,
      };
      expect(previews).toEqual([input, input, input]);
      expect(submissions).toHaveLength(3);
      expect(submissions[0]!.command.poolGameCorrectionToken).toBe('a'.repeat(64));
      expect(submissions[1]!.command.poolGameCorrectionToken).toBe('b'.repeat(64));
      expect(submissions[1]!.requestId).not.toBe(submissions[0]!.requestId);
      expect(submissions[2]).toEqual(submissions[1]);

      await card.getByRole('button', { name: 'Correct score' }).click();
      await card.getByRole('spinbutton').last().fill('0');
      await reviewButton.press('Enter');
      await expect(dialog).toContainText('Correct 2–1 to 2–0?');
      await dialog.getByRole('button', { name: 'Confirm', exact: true }).press('Enter');
      await expect(
        card.getByText('Another TO updated this match. Cancel and reopen to use the latest score.'),
      ).toBeVisible();
      await expect(reviewButton).toBeDisabled();
      await card.getByRole('button', { name: 'Cancel', exact: true }).click();
      await card.getByRole('button', { name: 'Correct score' }).click();
      await expect(card.getByRole('spinbutton').first()).toHaveValue('3');
      await expect(card.getByRole('spinbutton').last()).toHaveValue('1');
      expect(previews[3]).toEqual({ ...input, expectedRevision: revision + 1, score2: 0 });
      expect(unexpected).toEqual([]);
    });

const cases = [
  { mode: 'shared', entry: 'score', theme: 'dark', width: 390 },
  { mode: 'station', entry: 'score', theme: 'light', width: 390 },
  { mode: 'shared', entry: 'approval', theme: 'light', width: 1440 },
  { mode: 'station', entry: 'approval', theme: 'dark', width: 1440 },
] as const;

for (const { mode, entry, theme, width } of cases)
  test(`${mode} desk opens the exact call for a blocked ${entry} at ${width}px in ${theme}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
    const history = {
      id: 'act:52',
      eventName: 'DecisionRecordedV1',
      version: 52,
      at: '2026-10-03T23:59:00.000Z',
      actor: 'Organiser',
      source: 'operator',
      category: 'scores',
      title: 'Score recorded',
      summary: 'Semifinal score',
      matchId: '',
      details: {},
    } as const;
    const options: FixtureOptions = {
      role: 'admin',
      idle: true,
      history: [{ entries: [{ ...history }], nextCursor: null }],
    };
    const { overview, unexpected } = await mockEvent(page, options);
    const feeder = overview.matches.find((match) => match.status === 'complete')!;
    const call = overview.matches.find((match) => match.status === 'ready')!;
    const alias = 'Alexandria with a long doubles alias / Captain Falcon from Western Sydney';
    options.history![0]!.entries[0]!.matchId = feeder.id;
    Object.assign(overview.plan, { bracketMode: 'native', drawPaused: false, liveOwned: true });
    Object.assign(feeder, { label: 'Semifinal feeder', score1: 2, score2: 0, outcome: 'played' });
    Object.assign(call, {
      label: 'Championship final',
      player1Name: alias,
      status: 'playing',
      started: false,
      called: mode === 'shared',
      stationId: mode === 'station' ? overview.stations[0]!.id : null,
      resourceRevision: 12,
    });
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
          reason: 'Waiting time, then draw order',
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
    const report = overview.reports[0]!;
    Object.assign(report, {
      matchId: feeder.id,
      expectedRevision: feeder.revision,
      status: 'pending',
      isDispute: true,
      score1: 0,
      score2: 2,
    });
    overview.reports = entry === 'approval' ? [report] : [];

    const submissions: object[] = [];
    const returns: object[] = [];
    const operation = entry === 'score' ? 'reportScore' : 'reviewReport';
    await page.route(`**/api/trpc/eventOps.${operation}*`, async (route) => {
      const batched = new URL(route.request().url()).searchParams.has('batch');
      const body = route.request().postDataJSON();
      submissions.push(batched ? body[0] : body);
      const result =
        submissions.length === 1
          ? {
              error: {
                message: 'Return an untaken call before changing its opponents.',
                code: -32009,
                data: { code: 'CONFLICT', httpStatus: 409, returnUntakenCallMatchIds: [call.id] },
              },
            }
          : { result: { data: { status: 'approved' } } };
      if (submissions.length > 1) Object.assign(report, { status: 'approved' });
      await route.fulfill({ json: batched ? [result] : result });
    });
    const returnPath = `/api/trpc/eventOps.${mode === 'shared' ? 'live.command' : 'updateMatch'}`;
    await page.route(`**${returnPath}*`, async (route) => {
      const batched = new URL(route.request().url()).searchParams.has('batch');
      const body = route.request().postDataJSON();
      const input = batched ? body[0] : body;
      returns.push(mode === 'shared' ? input.command : input);
      Object.assign(call, { status: 'ready', called: false, resourceRevision: 13 });
      desk.queue = [];
      desk.active = 0;
      const result = { result: { data: {} } };
      await route.fulfill({ json: batched ? [result] : result });
    });

    await page.goto(`/operate/${PLAN_ID}${entry === 'score' ? '?view=history' : ''}`);
    const card = page.locator('article.ops-match:visible').filter({ hasText: feeder.label });
    if (entry === 'score') {
      await page.getByRole('button', { name: 'Open match', exact: true }).click();
      await card.getByRole('button', { name: 'Correct score' }).click();
      await card.getByRole('spinbutton').first().fill('0');
      await card.getByRole('spinbutton').last().fill('2');
    }
    const submit =
      entry === 'score'
        ? card.getByRole('button', { name: 'Confirm result' })
        : page.getByRole('button', { name: 'Use submitted result' });
    await submit.click();
    const open = page.getByRole('button', { name: new RegExp(`^Open call for ${alias}`) });
    await expect(open).toBeVisible();
    await expect(page.getByRole('button', { name: /^Open call for/ })).toHaveCount(1);
    await ready(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      (
        await new AxeBuilder({ page })
          .include('.ops-page')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await open.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('correction-call.png') });
    await open.press('Enter');
    const returnCall = page.locator(`[id="return-call-${call.id}"]`);
    await expect(returnCall).toBeFocused();
    await expect(returnCall).toHaveText(
      mode === 'shared' ? 'Return untaken call' : 'Return to queue',
    );
    expect(returns).toHaveLength(0);
    // The recovery link hides while the return is pending, before its request can complete.
    const [returned] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' && new URL(response.url()).pathname === returnPath,
      ),
      returnCall.press('Enter'),
    ]);
    expect(returned.ok()).toBe(true);
    await expect(submit).toBeEnabled();
    await expect(open).toHaveCount(0);
    expect(returns).toEqual([
      expect.objectContaining({
        matchId: call.id,
        expectedRevision: call.revision,
        expectedResourceRevision: 12,
        status: 'ready',
      }),
    ]);
    expect(
      await card
        .getByRole('spinbutton')
        .evaluateAll((fields) => fields.map((field) => (field as HTMLInputElement).value)),
    ).toEqual(entry === 'score' ? ['0', '2'] : []);
    await submit.click();
    await expect(
      page.getByRole('status').filter({ hasText: /Score recorded locally|Player score approved/ }),
    ).toBeVisible();
    expect(submissions).toHaveLength(2);
    expect(submissions[1]).toEqual(submissions[0]);
    expect(unexpected).toEqual([]);
  });
