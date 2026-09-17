import { test, expect, type APIRequestContext } from '@playwright/test';

type Match = { id: string; label: string; status: string; division: string; revision: number; stationId: string | null; player1Id: string; player2Id: string; score1: number | null };
type Snapshot = { matches: Match[]; stations: Array<{ id: string; name: string }>; reports?: Array<{ id: string; matchId: string; status: string }> };
const password = 'devpassword123';
async function signIn(request: APIRequestContext, email: string) {
  const response = await request.post('/api/auth/sign-in/email', { data: { email, password } });
  expect(response.ok(), await response.text()).toBe(true);
}
async function query<T>(request: APIRequestContext, procedure: string, input?: object): Promise<T> {
  const response = await request.get(`/api/trpc/${procedure}`, { params: input ? { input: JSON.stringify(input) } : {} });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result.data as T;
}
async function mutate(request: APIRequestContext, procedure: string, data: object) {
  return request.post(`/api/trpc/${procedure}`, { data });
}

test('rehearsal: two TOs, score approval, station safety, public board and OBS', async ({ page, browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  await signIn(page.request, 'admin@smashclub.dev');
  const plans = await query<Array<{ id: string; name: string }>>(page.request, 'admin.eventPlanner.plans');
  const plan = plans.find(plan => plan.name === 'Nemesis · Rehearsal Night');
  expect(plan, 'the development harness must seed its operations rehearsal').toBeTruthy();
  const planId = plan!.id;
  const initial = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
  const planner = await query<{ divisions: Array<{ division: string; pools: Array<{ members: unknown[] }> }> }>(page.request, 'admin.eventPlanner.plan', { planId });
  const pools = planner.divisions.flatMap(division => division.pools);
  expect(new Set(pools.map(pool => pool.members.length)).size).toBeGreaterThan(1);
  expect(initial.matches).toHaveLength(pools.reduce((sum, pool) => sum + pool.members.length * (pool.members.length - 1) / 2, 0));
  const completedPoolSize = planner.divisions.find(division => division.division === 'lower')!.pools[0]!.members.length;
  expect(initial.matches.filter(match => match.status === 'complete')).toHaveLength(completedPoolSize * (completedPoolSize - 1) / 2);
  const playing = initial.matches.find(match => match.status === 'playing')!;
  const stage = initial.stations.find(station => station.name === 'Stage')!;

  const toContext = await browser.newContext({ baseURL });
  const playerContext = await browser.newContext({ baseURL });
  try {
    await signIn(toContext.request, 'organiser@smashclub.dev');
    const toPage = await toContext.newPage();
    await toPage.goto(`/operate/${planId}`);
    await expect(toPage.getByRole('heading', { name: plan!.name })).toBeVisible();
    await expect(toPage.getByRole('heading', { name: 'Event access' })).toHaveCount(0);
    const forbidden = await mutate(toContext.request, 'eventOps.settings', { planId, published: false, playerReports: false });
    expect(forbidden.status()).toBe(403);

    const ready = initial.matches.find(match => match.status === 'ready' && match.division === 'lower')!;
    const conflict = await mutate(toContext.request, 'eventOps.updateMatch', { matchId: ready.id, expectedRevision: ready.revision, status: 'playing', stationId: stage.id });
    expect(conflict.status()).toBe(409);
    expect((await query<Snapshot>(page.request, 'eventOps.snapshot', { planId })).matches.find(match => match.id === ready.id)!.status).toBe('ready');

    await page.goto(`/admin/event-operations?plan=${planId}`);
    const scoreCard = page.locator('article.ops-match').filter({ hasText: ready.label });
    await scoreCard.getByRole('button', { name: 'Record score', exact: true }).click();
    await scoreCard.locator('input[type="number"]').nth(0).fill('2');
    await scoreCard.locator('input[type="number"]').nth(1).fill('1');
    await scoreCard.getByRole('button', { name: 'Confirm result', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Score recorded locally');
    expect((await query<Snapshot>(page.request, 'eventOps.snapshot', { planId })).matches.find(match => match.id === ready.id)!.status).toBe('complete');

    await signIn(playerContext.request, 'rehearsal-player@smashclub.dev');
    const playerPage = await playerContext.newPage();
    await playerPage.goto(`/play/${planId}`);
    const playerCard = playerPage.locator('article.ops-match').filter({ hasText: playing.label });
    await playerCard.locator('input[type="number"]').nth(0).fill('2');
    await playerCard.locator('input[type="number"]').nth(1).fill('0');
    await playerCard.getByRole('button', { name: 'Submit score for approval' }).click();
    await expect(playerCard).toContainText(/submitted|pending/i);
    const pendingSnapshot = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
    expect(pendingSnapshot.matches.find(match => match.id === playing.id)!.status).toBe('playing');
    const report = page.locator('.ops-report').filter({ hasText: playing.label });
    await expect(report).toBeVisible();
    await report.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Player score approved');
    await expect(playerCard).toContainText('Confirmed: 2');

    for (const message of ['Rehearsal notice oldest', 'Rehearsal notice recent', 'Rehearsal notice newest']) {
      const response = await mutate(page.request, 'eventOps.announce', { planId, message });
      expect(response.ok(), await response.text()).toBe(true);
    }
    await page.goto(`/live/${planId}`);
    await expect(page.getByRole('heading', { name: plan!.name })).toBeVisible();
    await expect(page.locator('.app-nav')).toHaveCount(0);
    await expect(page.locator('.event-announcements')).toContainText('Rehearsal notice newest');
    await expect(page.locator('.event-announcements')).not.toContainText('Rehearsal notice oldest');
    await expect(page.getByRole('heading', { name: 'Confirmed pool standings' })).toBeVisible();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: /Download results graphic/ }).first().click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('smash-club-results.svg');
    await download.saveAs(testInfo.outputPath('pool-results.svg'));
    await page.screenshot({ path: testInfo.outputPath('live-board.png'), fullPage: true });

    await page.goto(`/overlay/${planId}?captureWidth=68&captureHeight=65`);
    await expect(page.locator('.event-capture')).toBeVisible();
    const geometry = await page.locator('.event-capture').evaluate(element => {
      const box = element.getBoundingClientRect();
      return { width: box.width / innerWidth, height: box.height / innerHeight,
        background: getComputedStyle(element).backgroundColor, documentBackground: getComputedStyle(document.documentElement).backgroundColor };
    });
    expect(geometry.width).toBeCloseTo(0.68, 2);
    expect(geometry.height).toBeCloseTo(0.65, 2);
    expect(geometry.background).toBe('rgba(0, 0, 0, 0)');
    expect(geometry.documentBackground).toBe('rgba(0, 0, 0, 0)');
    await page.screenshot({ path: testInfo.outputPath('obs-overlay.png'), omitBackground: true });
  } finally {
    await toContext.close();
    await playerContext.close();
  }
});
