import { expect, test, type APIRequestContext } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';

type Source = {
  poolId: string;
  poolIndex: number;
  division: string;
  place: number;
  status: string;
};
type Match = {
  id: string;
  label: string;
  revision: number;
  status: string;
  nativeBracketId: string | null;
  player1Id: string | null;
  player2Id: string | null;
  player1Name: string;
  player2Name: string;
  player1Qualifier?: Source;
  player2Qualifier?: Source;
  qualificationBlocks?: Source[];
  poolIndex: number | null;
  score1: number | null;
  score2: number | null;
  winnerId: string | null;
  outcome: string | null;
  called: boolean;
  started: boolean;
};
type Snapshot = {
  matches: Match[];
  plan: { status: string };
  poolSchedules: { poolIndex: number; active: boolean }[];
};
type Live = {
  matches: Match[];
  settings: { resourceRevision: number };
  pools: {
    id: string;
    index: number;
    entrantIds: string[];
    order: string[] | null;
    active: boolean;
  }[];
};
async function query<T>(request: APIRequestContext, procedure: string, input: object): Promise<T> {
  const response = await request.get(`/api/trpc/${procedure}`, {
    params: { input: JSON.stringify(input) },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result.data as T;
}
async function mutate<T = unknown>(
  request: APIRequestContext,
  procedure: string,
  input: object,
): Promise<T> {
  const response = await request.post(`/api/trpc/${procedure}`, { data: input });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result.data as T;
}
async function signIn(request: APIRequestContext, email: string) {
  const response = await request.post('/api/auth/sign-in/email', {
    data: { email, password: 'devpassword123' },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

test('real native mixed-stage finals preserve held pools, truthful phone qualification, actual calls and reviewed identities', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(180_000);
  await signIn(page.request, 'admin@smashclub.dev');
  const players = (
    await query<{ id: string; canonicalName: string; status: string }[]>(
      page.request,
      'admin.players',
      {},
    )
  )
    .filter((p) => p.status === 'active')
    .slice(0, 16);
  expect(players).toHaveLength(16);
  const { planId } = await mutate<{ planId: string }>(
    page.request,
    'admin.eventPlanner.createPlan',
    {
      name: 'Rolling finals mixed-stage rehearsal',
      eventDate: '2026-10-31T08:00:00Z',
      bracketMode: 'native',
      structure: 'pools_finals',
      rows: players.map((p, i) => ({
        lineNumber: i + 1,
        rawInput: p.canonicalName,
        cleanedName: p.canonicalName,
        playerId: p.id,
        companyId: null,
        resolutionMethod: 'manual',
      })),
    },
  );
  for (const procedure of [
    'admin.eventPlanner.freezeRoster',
    'admin.eventPlanner.generatePools',
    'eventOps.softLockPools',
  ])
    await mutate(page.request, procedure, {
      planId,
      ...(procedure === 'eventOps.softLockPools' ? { confirm: true } : {}),
    });
  await mutate(page.request, 'eventOps.settings', {
    planId,
    published: true,
    playerReports: true,
    scoreReportingMode: 'approve_unless_disputed',
  });
  let live = await query<Live>(page.request, 'eventOps.live.snapshot', { planId });
  expect(live.pools).toHaveLength(4);
  await mutate(page.request, 'eventOps.live.command', {
    planId,
    requestId: 'rolling-shared-capacity',
    command: {
      kind: 'configureDispatch',
      capacity: 2,
      reservedStationIds: [],
      expectedResourceRevision: live.settings.resourceRevision,
    },
  });
  live = await query<Live>(page.request, 'eventOps.live.snapshot', { planId });
  const heldPool = live.pools[2]!;
  await mutate(page.request, 'eventOps.live.command', {
    planId,
    requestId: 'hold-third-pool',
    command: {
      kind: 'poolResources',
      poolId: heldPool.id,
      active: false,
      stationIds: [],
      selfRun: false,
      autoAcceptScores: false,
      expectedResourceRevision: live.settings.resourceRevision,
    },
  });
  const firstPool = live.pools[0]!,
    lastPool = live.pools[3]!;
  const chosen = firstPool.entrantIds[1]!;

  await page.goto(`/admin/event-operations?plan=${planId}`);
  await page.getByRole('tab', { name: 'Standings / draw', exact: true }).click();
  const finals = page.locator('section.card').filter({
    has: page.getByRole('heading', { name: 'Championship and consolation', exact: true }),
  });
  await finals.getByRole('button', { name: 'Preview finals', exact: true }).click();
  await expect(finals).toContainText('will not shrink or reseed');
  await expect(finals).toContainText('Upper Pool A · place 1');
  await finals.getByRole('button', { name: 'Create these finals', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toContainText('fixes the current eligible field');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(finals.getByRole('status')).toContainText('Finals are ready');
  let snapshot = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
  expect(
    snapshot.matches
      .filter((m) => m.nativeBracketId)
      .every((m) => m.status === 'blocked' && m.outcome === null && m.winnerId === null),
  ).toBe(true);
  const topology = snapshot.matches.filter((m) => m.nativeBracketId).map((m) => m.id);

  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
  try {
    await signIn(context.request, 'player@smashclub.dev');
    const phone = await context.newPage();
    await phone.goto(`/play/${planId}?player=${chosen}`);
    await expect(
      phone.getByRole('heading', { name: 'Finals qualification', exact: true }),
    ).toBeVisible();
    await expect(phone.locator('.player-bracket-path')).toHaveCount(0);
    await phone
      .locator('#event-brackets')
      .getByRole('button', { name: 'Full draw & bracket standings', exact: true })
      .click();
    await expect(phone.locator('#event-brackets')).toContainText('Upper Pool A · place 1');
    for (const match of snapshot.matches.filter((m) => m.nativeBracketId))
      await expect(phone.locator('article.ops-match').filter({ hasText: match.label })).toHaveCount(
        0,
      );
    await phone.screenshot({
      path: testInfo.outputPath('rolling-phone-before-qualification.png'),
      fullPage: true,
    });

    const finishPool = async (pool: Live['pools'][number]) => {
      const current = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
      for (const m of current.matches.filter(
        (m) => m.poolIndex === pool.index && m.nativeBracketId === null,
      )) {
        const first = pool.entrantIds.indexOf(m.player1Id!) < pool.entrantIds.indexOf(m.player2Id!);
        await mutate(page.request, 'eventOps.reportScore', {
          matchId: m.id,
          expectedRevision: m.revision,
          requestId: m.id,
          score1: first ? 2 : 0,
          score2: first ? 0 : 2,
          outcome: 'played',
        });
      }
    };
    await finishPool(firstPool);
    snapshot = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
    const assigned = snapshot.matches.find(
      (m) => m.nativeBracketId && [m.player1Id, m.player2Id].includes(chosen),
    )!;
    expect(assigned).toBeDefined();
    expect(assigned.player1Id === null || assigned.player2Id === null).toBe(true);
    await phone.reload();
    await expect(
      phone.getByRole('heading', { name: 'Your bracket path', exact: true }),
    ).toBeVisible();
    const personal = phone.locator('article.ops-match').filter({ hasText: assigned.label });
    await expect(personal).toContainText('Awaiting opponent');
    await expect(personal.getByRole('spinbutton')).toHaveCount(0);

    await finishPool(lastPool);
    snapshot = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
    const ready = snapshot.matches.find((m) => m.id === assigned.id)!;
    expect(ready.status).toBe('ready');
    expect(ready.player1Id && ready.player2Id).toBeTruthy();
    expect(snapshot.poolSchedules.find((p) => p.poolIndex === heldPool.index)!.active).toBe(false);
    expect(
      snapshot.matches
        .filter((m) => m.poolIndex === heldPool.index && m.nativeBracketId === null)
        .every((m) => m.status !== 'complete'),
    ).toBe(true);
    await phone.reload();
    await expect(personal.getByRole('spinbutton')).toHaveCount(2);
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );

    await page.getByRole('tab', { name: 'Run matches', exact: true }).click();
    const desk = page.getByRole('region', { name: 'TO match queue', exact: true });
    const row = desk.locator(`[data-match-id="${ready.id}"]`);
    await row.getByRole('button', { name: 'Call ordinary match', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await query<Snapshot>(page.request, 'eventOps.snapshot', { planId })).matches.find(
            (m) => m.id === ready.id,
          )!.called,
      )
      .toBe(true);
    await expect(desk).toContainText('1 / 2 in use');
    const actualIds = [ready.player1Id, ready.player2Id];
    const poolResult = snapshot.matches.find(
      (m) => m.nativeBracketId === null && m.poolIndex === firstPool.index,
    )!;
    const report = await mutate<{ id: string; status: string; isDispute: boolean }>(
      context.request,
      'eventOps.reportScore',
      {
        matchId: poolResult.id,
        expectedRevision: poolResult.revision,
        requestId: 'phone-source-dispute',
        score1: poolResult.score1 === 2 ? 0 : 2,
        score2: poolResult.score2 === 2 ? 0 : 2,
        outcome: 'played',
      },
    );
    expect(report).toMatchObject({ status: 'pending', isDispute: true });
    snapshot = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
    const called = snapshot.matches.find((m) => m.id === ready.id)!;
    expect([called.player1Id, called.player2Id]).toEqual(actualIds);
    expect(called.status).toBe('playing');
    expect(called.qualificationBlocks!.some((q) => q.status === 'review_pending')).toBe(true);
    await phone.reload();
    await expect(phone.locator('#event-brackets')).toContainText('Qualification under review');
    await expect(personal).toContainText('under review');
    await expect(personal.getByRole('spinbutton')).toHaveCount(2);
    await mutate(page.request, 'eventOps.reviewReport', { reportId: report.id, approve: false });
    await phone.reload();
    await expect(personal.getByRole('spinbutton')).toHaveCount(2);
    await personal.getByRole('spinbutton').nth(0).fill('2');
    await personal.getByRole('spinbutton').nth(1).fill('0');
    await personal.getByRole('button', { name: 'Confirm result', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await query<Snapshot>(page.request, 'eventOps.snapshot', { planId })).matches.find(
            (m) => m.id === ready.id,
          )!.status,
      )
      .toBe('complete');
    snapshot = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
    expect(snapshot.matches.filter((m) => m.nativeBracketId).map((m) => m.id)).toEqual(topology);
    expect([
      snapshot.matches.find((m) => m.id === ready.id)!.player1Id,
      snapshot.matches.find((m) => m.id === ready.id)!.player2Id,
    ]).toEqual(actualIds);
    expect(snapshot.plan.status).toBe('underway');
    const cannotClose = await page.request.post('/api/trpc/eventOps.native.finalize', {
      data: { planId },
    });
    expect(cannotClose.status()).toBe(409);
    await phone.screenshot({
      path: testInfo.outputPath('rolling-phone-after-known-final.png'),
      fullPage: true,
    });
    const accessibility = await new AxeBuilder({ page: phone })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    expect(accessibility.violations).toEqual([]);
    await page.reload();
    await page.screenshot({
      path: testInfo.outputPath('rolling-to-mixed-stage-desktop.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('region', { name: 'TO match queue', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath('rolling-to-mixed-stage-phone.png'),
      fullPage: true,
    });
  } finally {
    await context.close();
  }
});
