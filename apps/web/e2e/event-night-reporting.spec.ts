import { expect, test, type APIRequestContext } from '@playwright/test';

type Match = { id: string; label: string; status: string; revision: number; division: string; poolIndex: number | null; player1Id: string; player2Id: string; score1: number | null; score2: number | null; winnerId: string | null; resultUpdatedAt: string | null; availability: { canStart: boolean } };
type Snapshot = { plan: { bracketMode: string }; matches: Match[]; stations: { id: string; name: string; status: string }[] };
async function signIn(request: APIRequestContext, email: string) {
  const response = await request.post('/api/auth/sign-in/email', { data: { email, password: 'devpassword123' } });
  expect(response.ok(), await response.text()).toBe(true);
}
async function query<T>(request: APIRequestContext, procedure: string, input?: object): Promise<T> {
  const response = await request.get(`/api/trpc/${procedure}`, { params: input ? { input: JSON.stringify(input) } : {} });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result.data as T;
}
async function mutate<T = unknown>(request: APIRequestContext, procedure: string, data: object): Promise<T> {
  const response = await request.post(`/api/trpc/${procedure}`, { data });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result.data as T;
}
async function freshEvent(request: APIRequestContext, suffix: string) {
  const plans = await query<{ id: string; name: string }[]>(request, 'admin.eventPlanner.plans');
  const source = plans.find(plan => plan.name === 'Nemesis · Rehearsal Night')!;
  const roster = await query<{ entries: { playerId: string; playerName: string; companyId: string | null }[] }>(request, 'admin.eventPlanner.plan', { planId: source.id });
  const created = await mutate<{ planId: string }>(request, 'admin.eventPlanner.createPlan', { name: `Night regression ${suffix} ${Date.now()}`, bracketMode: 'native', eventDate: new Date().toISOString(), upperTargetSize: 9,
    rows: roster.entries.map((entry, index) => ({ lineNumber: index + 1, rawInput: entry.playerName, cleanedName: entry.playerName, playerId: entry.playerId, companyId: entry.companyId ?? null, resolutionMethod: 'manual', divisionPreference: 'auto' })) });
  for (const procedure of ['admin.eventPlanner.freezeRoster', 'admin.eventPlanner.generatePools', 'eventOps.prepare']) await mutate(request, procedure, created);
  await mutate(request, 'eventOps.settings', { ...created, published: true, playerReports: true });
  return { ...created, snapshot: await query<Snapshot>(request, 'eventOps.snapshot', created) };
}

test('an unlinked signed-in attendee reports different players and loses the form when unpublished', async ({ page, browser, baseURL }) => {
  await signIn(page.request, 'admin@smashclub.dev');
  const { planId, snapshot } = await freshEvent(page.request, 'unlinked reporting');
  expect(snapshot.plan.bracketMode).toBe('native');
  const attendee = await browser.newContext({ baseURL });
  try {
    await signIn(attendee.request, 'player@smashclub.dev');
    const claims = await query<{ status: string }[]>(attendee.request, 'me.claims');
    expect(claims.some(claim => claim.status === 'approved')).toBe(false);
    const reporting = await attendee.newPage();
    await reporting.goto(`/play/${planId}`);
    await reporting.getByRole('combobox', { name: 'Match view', exact: true }).selectOption('all');
    const chosen = ['upper', 'lower'].map(division => snapshot.matches.find(match => match.division === division)!);
    for (const match of chosen) {
      const card = reporting.locator('article.ops-match').filter({ hasText: match.label });
      await card.locator('input[type="number"]').nth(0).fill('2');
      await card.locator('input[type="number"]').nth(1).fill('1');
      await card.getByRole('button', { name: 'Submit score for approval' }).click();
      await expect(card).toContainText('Score submitted for TO approval');
    }
    const reports = await query<{ id: string; matchId: string; status: string }[]>(attendee.request, 'eventOps.myReports', { planId });
    expect(reports).toHaveLength(2);
    expect(reports.every(report => report.status === 'pending')).toBe(true);
    const beforeApproval = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
    expect(beforeApproval.matches.filter(match => chosen.some(item => item.id === match.id)).every(match => match.status === 'ready')).toBe(true);
    await mutate(page.request, 'eventOps.reviewReport', { reportId: reports[0]!.id, approve: true });
    await expect(reporting.locator('article.ops-match').filter({ hasText: chosen.find(match => match.id === reports[0]!.matchId)!.label })).toContainText('Confirmed: 2 – 1');
    await expect(reporting.getByRole('button', { name: 'Submit score for approval' }).first()).toBeVisible();
    await mutate(page.request, 'eventOps.settings', { planId, published: false, playerReports: true });
    await expect(reporting.getByRole('alert')).toContainText('This event is unavailable or has not been published.');
    await expect(reporting.locator('article.ops-match')).toHaveCount(0);
    await expect(reporting.getByRole('button', { name: 'Submit score for approval' })).toHaveCount(0);
  } finally { await attendee.close(); }
});

test('TO live scores stay unfinished while station options and pool holds follow availability', async ({ page }) => {
  await signIn(page.request, 'admin@smashclub.dev');
  const { planId, snapshot } = await freshEvent(page.request, 'live scores and stations');
  for (const name of ['Station A', 'Station B']) await mutate(page.request, 'eventOps.saveStation', { planId, name });
  const upper = snapshot.matches.find(match => match.division === 'upper' && match.poolIndex === 0)!;
  const lower = snapshot.matches.find(match => match.division === 'lower' && match.poolIndex === 0)!;
  await page.goto(`/admin/event-operations?plan=${planId}`);
  const upperCard = page.locator('article.ops-match').filter({ has: page.getByText(upper.label, { exact: true }) });
  const lowerCard = page.locator('article.ops-match').filter({ has: page.getByText(lower.label, { exact: true }) });
  await upperCard.getByRole('combobox', { name: `Station for ${upper.label}` }).selectOption({ label: 'Station A' });
  await upperCard.getByRole('button', { name: 'Start match', exact: true }).click();
  await upperCard.getByRole('button', { name: 'Update live score', exact: true }).click();
  await upperCard.locator('input[type="number"]').nth(0).fill('1');
  await upperCard.locator('input[type="number"]').nth(1).fill('0');
  await upperCard.getByRole('button', { name: 'Save live score', exact: true }).click();
  await expect(page.locator('.ops-notice')).toContainText('Live score updated');
  await expect(upperCard).toContainText('Live game score · match still in progress');
  let live = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
  expect(live.matches.find(match => match.id === upper.id)).toMatchObject({ status: 'playing', score1: 1, score2: 0, winnerId: null, resultUpdatedAt: null });
  await expect(lowerCard.locator('select option').filter({ hasText: 'Station A' })).toHaveCount(0);
  await expect(lowerCard.locator('select option').filter({ hasText: 'Station B' })).toHaveCount(1);
  const schedule = page.locator('article.ops-pool-schedule').filter({ hasText: 'Lower Pool A' });
  await schedule.getByRole('checkbox', { name: 'Allow this pool to play now' }).uncheck();
  await schedule.getByRole('button', { name: 'Save pool settings' }).click();
  await expect(lowerCard).toContainText('This pool is scheduled for a later wave.');
  await expect(lowerCard.getByRole('button', { name: 'Start match', exact: true })).toBeDisabled();
  await schedule.getByRole('checkbox', { name: 'Allow this pool to play now' }).check();
  await schedule.getByRole('button', { name: 'Save pool settings' }).click();
  await expect(lowerCard.getByRole('button', { name: 'Start match', exact: true })).toBeEnabled();
  await upperCard.getByRole('button', { name: 'Finish match', exact: true }).click();
  await upperCard.locator('input[type="number"]').nth(0).fill('2');
  await upperCard.getByRole('button', { name: 'Confirm result', exact: true }).click();
  await expect(page.locator('.ops-notice')).toContainText('Score recorded locally');
  live = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
  expect(live.matches.find(match => match.id === upper.id)).toMatchObject({ status: 'complete', score1: 2, score2: 0 });
  expect(live.stations.find(station => station.name === 'Station A')!.status).toBe('free');
  await expect(lowerCard.locator('select option').filter({ hasText: 'Station A' })).toHaveCount(1);
});
