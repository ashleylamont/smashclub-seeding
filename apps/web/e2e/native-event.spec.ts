import { test, expect, type APIRequestContext } from '@playwright/test';

type Match = { id: string; revision: number; status: string; player1Id: string | null; player2Id: string | null; nativeBracketId: string | null; division: string; poolIndex: number | null };
type Snapshot = { matches: Match[]; nativeBrackets: { complete: boolean; winnerId: string | null }[]; plan: { status: string; bracketMode: string } };
async function query<T>(request: APIRequestContext, procedure: string, input?: object): Promise<T> {
  const response = await request.get(`/api/trpc/${procedure}`, { params: input ? { input: JSON.stringify(input) } : {} });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result.data as T;
}
async function mutate<T>(request: APIRequestContext, procedure: string, data: object): Promise<T> {
  const response = await request.post(`/api/trpc/${procedure}`, { data });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result.data as T;
}

test('native event progresses from pools through reviewed finals to public club results', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.request.post('/api/auth/sign-in/email', { data: { email: 'admin@smashclub.dev', password: 'devpassword123' } });
  const plans = await query<{ id: string; name: string }[]>(page.request, 'admin.eventPlanner.plans');
  const source = plans.find(plan => plan.name === 'Nemesis · Rehearsal Night')!;
  const roster = await query<{ entries: { playerId: string; playerName: string; companyId: string | null }[] }>(page.request, 'admin.eventPlanner.plan', { planId: source.id });
  const name = `Native finals rehearsal ${Date.now()}`;
  const { planId } = await mutate<{ planId: string }>(page.request, 'admin.eventPlanner.createPlan', {
    name, bracketMode: 'native', eventDate: new Date().toISOString(), upperTargetSize: 7,
    rows: roster.entries.slice(0, 14).map((entry, index) => ({ lineNumber: index + 1, rawInput: entry.playerName, cleanedName: entry.playerName, playerId: entry.playerId, companyId: entry.companyId ?? null, resolutionMethod: 'manual', divisionPreference: 'auto' })),
  });
  for (const procedure of ['admin.eventPlanner.freezeRoster', 'admin.eventPlanner.generatePools', 'eventOps.prepare']) await mutate(page.request, procedure, { planId });
  await mutate(page.request, 'eventOps.settings', { planId, published: true, playerReports: true });
  let snapshot = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
  expect(snapshot.plan.bracketMode).toBe('native');
  type Pool = { poolIndex: number; members: { playerId: string }[]; matchRevisions: { id: string; revision: number }[]; placementRevision: string };
  type Planner = { divisions: { division: string; pools: Pool[] }[] };
  const before = await query<Planner>(page.request, 'admin.eventPlanner.plan', { planId });
  for (const match of snapshot.matches) {
    const order = before.divisions.find(division => division.division === match.division)!.pools.find(pool => pool.poolIndex === match.poolIndex)!.members.map(member => member.playerId);
    const firstWins = order.indexOf(match.player1Id!) < order.indexOf(match.player2Id!);
    await mutate(page.request, 'eventOps.reportScore', { matchId: match.id, expectedRevision: match.revision, requestId: crypto.randomUUID(), score1: firstWins ? 2 : 0, score2: firstWins ? 0 : 2, outcome: 'played' });
  }
  const scored = await query<Planner>(page.request, 'admin.eventPlanner.plan', { planId });
  for (const division of scored.divisions) await mutate(page.request, 'admin.eventPlanner.savePoolPlacements', { planId, division: division.division, pools: division.pools.map(pool => ({ poolIndex: pool.poolIndex, playerIdsInOrder: pool.members.map(member => member.playerId), expectedMatchRevisions: pool.matchRevisions, expectedPlacementRevision: pool.placementRevision })) });
  await page.goto(`/admin/event-operations?plan=${planId}`);
  await expect(page.getByText('Challonge integration', { exact: true })).toHaveCount(0);
  const finals = page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Championship and consolation', exact: true }) });
  await finals.getByRole('button', { name: 'Preview finals', exact: true }).click();
  await expect(finals.getByRole('heading', { name: 'upper championship · 4 entrants' })).toBeVisible();
  await expect(finals).toContainText('Bye');
  await finals.getByRole('button', { name: 'Create these finals' }).click();
  await expect(finals.getByRole('status')).toContainText('Finals are ready');
  for (let round = 0; round < 5; round++) {
    snapshot = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
    const ready = snapshot.matches.filter(match => match.nativeBracketId && match.status === 'ready');
    if (!ready.length) break;
    for (const match of ready) await mutate(page.request, 'eventOps.reportScore', { matchId: match.id, expectedRevision: match.revision, requestId: crypto.randomUUID(), score1: 2, score2: 1, outcome: 'played' });
  }
  expect(snapshot.nativeBrackets).toHaveLength(4);
  expect(snapshot.nativeBrackets.every(bracket => bracket.complete && bracket.winnerId)).toBe(true);
  page.once('dialog', dialog => dialog.accept());
  await finals.getByRole('button', { name: 'Finalize native results', exact: true }).click();
  await expect(finals.getByRole('status')).toContainText('Event finalized');
  await expect(page.getByText('Event closed · read only', { exact: true })).toBeVisible();
  await page.goto(`/live/${planId}`);
  await expect(page.locator('.event-bracket')).toHaveCount(4);
  await expect(page.getByText('The next set is coming.', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Report your match score →' })).toHaveCount(0);
  await expect(page.locator('.event-bracket').first()).toContainText('Winner');
  await expect(page.locator('a[href*="challonge.com"]')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('native-completed-night.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('native-completed-night-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/admin/tournaments');
  const resultRow = page.getByRole('row').filter({ hasText: `${name} Upper Main` });
  await expect(resultRow).toContainText('Saved in Nemesis');
  await resultRow.getByRole('link', { name: 'Nemesis event results →' }).click();
  await expect(page).toHaveURL(/\/events\/nemesis_/);
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
});
