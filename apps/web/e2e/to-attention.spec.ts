import { expect, test, type APIRequestContext } from '@playwright/test';
async function query<T>(request: APIRequestContext, procedure: string, input?: object): Promise<T> {
  const response = await request.get(`/api/trpc/${procedure}`, {
    params: input ? { input: JSON.stringify(input) } : {},
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result.data;
}
async function mutate<T = unknown>(
  request: APIRequestContext,
  procedure: string,
  data: object,
): Promise<T> {
  const response = await request.post(`/api/trpc/${procedure}`, { data });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result.data;
}
type Snapshot = {
  matches: {
    id: string;
    label: string;
    division: string;
    poolIndex: number;
    revision: number;
    status: string;
    player1Id: string;
    player2Id: string;
    score1: number | null;
    score2: number | null;
  }[];
  reports: { id: string; matchId: string; status: string; expectedRevision: number }[];
};
test('attention desk directs TOs to exact decisions and stale scores, without classifying later waves as problems', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  await page.request.post('/api/auth/sign-in/email', {
    data: { email: 'admin@smashclub.dev', password: 'devpassword123' },
  });
  const plans = await query<{ id: string; name: string }[]>(
    page.request,
    'admin.eventPlanner.plans',
  );
  const source = plans.find((plan) => plan.name === 'Nemesis · Rehearsal Night')!;
  const roster = await query<{ entries: { playerId: string; playerName: string }[] }>(
    page.request,
    'admin.eventPlanner.plan',
    { planId: source.id },
  );
  const { planId } = await mutate<{ planId: string }>(
    page.request,
    'admin.eventPlanner.createPlan',
    {
      name: `TO attention ${Date.now()}`,
      bracketMode: 'native',
      eventDate: new Date().toISOString(),
      upperTargetSize: 9,
      rows: roster.entries.map((entry, index) => ({
        lineNumber: index + 1,
        rawInput: entry.playerName,
        cleanedName: entry.playerName,
        playerId: entry.playerId,
        companyId: null,
        resolutionMethod: 'manual',
        divisionPreference: 'auto',
      })),
    },
  );
  for (const procedure of [
    'admin.eventPlanner.freezeRoster',
    'admin.eventPlanner.generatePools',
    'eventOps.prepare',
  ])
    await mutate(page.request, procedure, { planId });
  await mutate(page.request, 'eventOps.settings', { planId, published: true, playerReports: true });
  const initial = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
  const blocked = initial.matches.find((match) => match.division === 'upper')!;
  const reported = initial.matches.find(
    (match) => match.id !== blocked.id && match.division === 'upper',
  )!;
  await mutate(page.request, 'eventOps.updateMatch', {
    matchId: blocked.id,
    expectedRevision: blocked.revision,
    status: 'blocked',
    blockedReason: 'Confirm controller is working before starting',
  });
  await mutate(page.request, 'eventOps.configurePool', {
    planId,
    division: 'lower',
    poolIndex: 0,
    active: false,
    stationIds: [],
  });
  const guestContext = await browser.newContext({ baseURL });
  try {
    await guestContext.request.post('/api/auth/sign-in/email', {
      data: { email: 'rehearsal-player@smashclub.dev', password: 'devpassword123' },
    });
    const report = await mutate<{ id: string }>(guestContext.request, 'eventOps.reportScore', {
      matchId: reported.id,
      expectedRevision: reported.revision,
      requestId: crypto.randomUUID(),
      score1: 2,
      score2: 1,
      outcome: 'played',
    });
    await page.goto(`/admin/event-operations?plan=${planId}`);
    const attention = page.locator('.ops-attention');
    await expect(attention.getByRole('heading', { name: 'Needs attention 3' })).toBeVisible();
    await expect(attention).toContainText('No stations configured');
    await attention.getByText('Match decisions · 1', { exact: true }).click();
    // Pre-existing queue filters must not hide the exact match opened from attention.
    await page
      .locator('.ops-toolbar')
      .getByRole('combobox', { name: 'Division', exact: true })
      .selectOption('lower');
    await page
      .locator('.ops-toolbar')
      .getByRole('textbox', { name: 'Find a player or match', exact: true })
      .fill('not an entrant');
    await attention.getByRole('button', { name: 'Open match', exact: true }).click();
    await expect(page.locator('article.ops-match')).toHaveCount(1);
    await expect(page.locator('article.ops-match')).toContainText(blocked.label);
    await expect(page.locator('#match-desk')).toBeFocused();
    await page.getByRole('button', { name: 'Show all matches', exact: true }).click();
    await expect(page.locator('article.ops-match')).toHaveCount(initial.matches.length);
    await attention.getByText('Score reviews · 1', { exact: true }).click();
    await attention.getByRole('button', { name: 'Review score', exact: true }).click();
    await expect(page.locator('.ops-report')).toBeFocused();
    // Scheduling holds preserve the score revision and the pending submission.
    await mutate(page.request, 'eventOps.updateMatch', {
      matchId: reported.id,
      expectedRevision: reported.revision,
      status: 'blocked',
      blockedReason: 'Confirm players before recording result',
    });
    await expect(attention).toContainText('Confirm players before recording result');
    await expect(attention).not.toContainText('changed since submission');
    const approve = page
      .locator('.ops-report')
      .getByRole('button', { name: 'Approve', exact: true });
    await expect(approve).toBeEnabled();
    const held = await query<Snapshot>(page.request, 'eventOps.overview', { planId });
    expect(held.matches.find((match) => match.id === reported.id)!.revision).toBe(
      reported.revision,
    );
    expect(held.reports.find((item) => item.id === report.id)).toMatchObject({
      status: 'pending',
      expectedRevision: reported.revision,
    });
    // A concurrent result changes the score revision; the desk must explain the stale report.
    await mutate(page.request, 'eventOps.updateMatch', {
      matchId: reported.id,
      expectedRevision: reported.revision,
      status: 'ready',
    });
    await mutate(page.request, 'eventOps.reportScore', {
      matchId: reported.id,
      expectedRevision: reported.revision,
      requestId: crypto.randomUUID(),
      score1: 1,
      score2: 2,
      outcome: 'played',
    });
    await expect(attention).toContainText('1 changed since submission');
    await expect(attention).toContainText('Match changed — check the current result');
    await expect(approve).toBeDisabled();
    const staleApproval = await page.request.post('/api/trpc/eventOps.reviewReport', {
      data: { reportId: report.id, approve: true },
    });
    expect(staleApproval.status()).toBe(409);
    await page.locator('.ops-report').getByRole('button', { name: 'Reject', exact: true }).click();
    await expect(attention).not.toContainText('Score reviews');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath('to-attention-mobile.png') });
    await attention.screenshot({ path: testInfo.outputPath('to-attention-panel.png') });
    const final = await query<Snapshot>(page.request, 'eventOps.overview', { planId });
    expect(final.matches.find((match) => match.id === reported.id)).toMatchObject({
      status: 'complete',
      revision: reported.revision + 1,
      score1: 1,
      score2: 2,
    });
    expect(final.reports.find((item) => item.id === report.id)!.status).toBe('rejected');
    expect(final.reports.filter((report) => report.status === 'pending')).toHaveLength(0);
  } finally {
    await guestContext.close();
  }
});
