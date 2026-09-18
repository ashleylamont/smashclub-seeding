import { expect, test, type APIRequestContext } from '@playwright/test';

type Match = { id: string; label: string; status: string; revision: number; division: string; poolIndex: number | null; player1Name: string; player2Name: string; score1: number | null; score2: number | null };
type Snapshot = { matches: Match[]; stations: { id: string; name: string }[]; stationQueues: { stationId: string; currentMatchId: string | null; nextMatchId: string | null; upcoming: { matchId: string; round: number }[] }[]; poolRounds: { poolKey: string; rounds: { restingPlayerIds: string[] }[] }[] };
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

test('guests and signed-in attendees run a pool station and immediately advance its queue', async ({ page, browser, baseURL }, testInfo) => {
  await signIn(page.request, 'admin@smashclub.dev');
  const plans = await query<{ id: string; name: string }[]>(page.request, 'admin.eventPlanner.plans');
  const source = plans.find(plan => plan.name === 'Nemesis · Rehearsal Night')!;
  const roster = await query<{ entries: { playerId: string; playerName: string; companyId: string | null }[] }>(page.request, 'admin.eventPlanner.plan', { planId: source.id });
  const { planId } = await mutate<{ planId: string }>(page.request, 'admin.eventPlanner.createPlan', { name: `Pool player flow ${Date.now()}`, bracketMode: 'native', eventDate: new Date().toISOString(), upperTargetSize: 9,
    rows: roster.entries.map((entry, index) => ({ lineNumber: index + 1, rawInput: entry.playerName, cleanedName: entry.playerName, playerId: entry.playerId, companyId: entry.companyId ?? null, resolutionMethod: 'manual', divisionPreference: 'auto' })) });
  for (const procedure of ['admin.eventPlanner.freezeRoster', 'admin.eventPlanner.generatePools', 'eventOps.prepare']) await mutate(page.request, procedure, { planId });
  await mutate(page.request, 'eventOps.settings', { planId, published: true, playerReports: true });
  await mutate(page.request, 'eventOps.guests.configure', { planId, enabled: true, showOnOverlay: true });
  for (const name of ['Pool setup 1', 'Pool setup 2']) await mutate(page.request, 'eventOps.saveStation', { planId, name });
  const before = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
  await mutate(page.request, 'eventOps.configurePool', { planId, division: 'upper', poolIndex: 0, active: true, selfRun: true, autoAcceptScores: true, stationIds: before.stations.map(station => station.id), expectedRevision: 0 });
  let data = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
  const station = data.stations.find(item => item.name === 'Pool setup 1')!;
  const first = data.matches.find(match => match.id === data.stationQueues.find(queue => queue.stationId === station.id)!.nextMatchId)!;
  expect(data.poolRounds.find(pool => pool.poolKey === 'upper:0')!.rounds.every(round => round.restingPlayerIds.length === 1)).toBe(true);
  const invitation = await mutate<{ token: string }>(page.request, 'eventOps.guests.invitation', { planId });
  const guest = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
  const attendee = await browser.newContext({ baseURL });
  try {
    const guestPage = await guest.newPage();
    await guestPage.goto(`/guest/${planId}?pool=upper%3A0#token=${encodeURIComponent(invitation.token)}`);
    await expect(guestPage.getByLabel('Your pool')).toHaveValue('upper:0');
    await expect.poll(() => new URL(guestPage.url()).hash).toBe('');
    const guestStation = guestPage.locator('article.pool-flow-station').filter({ has: guestPage.getByRole('heading', { name: station.name, exact: true }) });
    await guestStation.getByRole('button', { name: 'We’re here — start match' }).click();
    const guestCard = guestPage.locator('article.ops-match').filter({ has: guestPage.getByRole('heading', { name: `${first.player1Name} vs ${first.player2Name}`, exact: true }) });
    await guestCard.locator('input[type="number"]').nth(0).fill('2');
    await guestCard.locator('input[type="number"]').nth(1).fill('1');
    await expect(guestCard.getByRole('button', { name: 'Confirm result', exact: true })).toBeEnabled();
    await guestPage.screenshot({ path: testInfo.outputPath('pool-guest-mobile.png'), fullPage: true });
    expect(await guestPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await guestCard.getByRole('button', { name: 'Confirm result', exact: true }).click();
    await expect(guestCard).toContainText('Confirmed result: 2 – 1');
    data = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
    expect(data.matches.find(match => match.id === first.id)).toMatchObject({ status: 'complete', score1: 2, score2: 1 });
    const next = data.matches.find(match => match.id === data.stationQueues.find(queue => queue.stationId === station.id)!.nextMatchId)!;
    expect(next.id).not.toBe(first.id);
    await expect(guestStation).toContainText(`${next.player1Name}`);
    await signIn(attendee.request, 'player@smashclub.dev');
    const attendeePage = await attendee.newPage();
    await attendeePage.goto(`/play/${planId}?pool=upper%3A0`);
    const attendeeStation = attendeePage.locator('article.pool-flow-station').filter({ has: attendeePage.getByRole('heading', { name: station.name, exact: true }) });
    await attendeeStation.getByRole('button', { name: 'We’re here — start match' }).click();
    const attendeeCard = attendeePage.locator('article.ops-match').filter({ has: attendeePage.getByRole('heading', { name: `${next.player1Name} vs ${next.player2Name}`, exact: true }) });
    await attendeeCard.locator('input[type="number"]').nth(0).fill('2');
    await attendeeCard.locator('input[type="number"]').nth(1).fill('0');
    await page.goto(`/overlay/${planId}?station=${station.id}&pool=upper%3A0&controls=0`);
    await expect(page.locator('.broadcast-rail-rule')).toContainText('COMING UP');
    await expect(page.locator('.broadcast-deck')).toContainText('provisional');
    await expect(page.getByRole('button', { name: 'We’re here — start match' })).toHaveCount(0);
    await attendeeCard.getByRole('button', { name: 'Confirm result', exact: true }).click();
    await expect(attendeeCard).toContainText('Confirmed: 2 – 0');
    await page.goto(`/live/${planId}?pool=upper%3A0`);
    await expect(page.getByLabel('Your pool')).toHaveValue('upper:0');
    await page.locator('.pool-flow-round-group summary').click();
    await expect(page.locator('.pool-flow-round-grid')).toContainText('Resting:');
    await expect(page.getByRole('button', { name: 'We’re here — start match' })).toHaveCount(0);
  } finally { await guest.close(); await attendee.close(); }
});

test('a selected pool keeps its last next match visible on an unreserved station', async ({ page }) => {
  await signIn(page.request, 'admin@smashclub.dev');
  const plans = await query<{ id: string; name: string }[]>(page.request, 'admin.eventPlanner.plans');
  const planId = plans.find(plan => plan.name === 'Nemesis · Rehearsal Night')!.id;
  let stationName = '';
  let playerName = '';
  await page.route('**/api/trpc/eventOps.snapshot*', async route => {
    const remote = await route.fetch();
    const payload = await remote.json();
    for (const item of Array.isArray(payload) ? payload : [payload]) {
      const data = item.result?.data;
      if (!data?.matches || !data.stations?.length) continue;
      const match = data.matches.find((candidate: Match) => candidate.division === 'upper' && candidate.poolIndex === 0 && candidate.status === 'ready');
      stationName = data.stations[0].name;
      playerName = match.player1Name;
      data.poolSchedules = [];
      data.stations = data.stations.map((station: { id: string; name: string }) => ({ ...station, status: 'free', currentMatchId: null }));
      data.stationQueues = data.stations.map((station: { id: string }, index: number) => ({ stationId: station.id, poolKey: null, currentMatchId: null, nextMatchId: index === 0 ? match.id : null, upcoming: [], waitingReason: null }));
    }
    await route.fulfill({ response: remote, json: payload });
  });
  await page.goto(`/live/${planId}?pool=upper%3A0`);
  const queues = page.getByRole('region', { name: 'Pool station queues' });
  await expect(queues.locator('article.pool-flow-station')).toHaveCount(1);
  await expect(queues.getByRole('heading', { name: stationName, exact: true })).toBeVisible();
  await expect(queues.locator('.pool-flow-next')).toContainText(playerName);
  await expect(queues).toContainText('PLAY NEXT');
  await expect(queues).not.toContainText('No station is assigned');
});

test('idle automatic overlay uses the Stage queue and labels later pairings as provisional', async ({ page }) => {
  await signIn(page.request, 'admin@smashclub.dev');
  const plans = await query<{ id: string; name: string }[]>(page.request, 'admin.eventPlanner.plans');
  const planId = plans.find(plan => plan.name === 'Nemesis · Rehearsal Night')!.id;
  await page.route('**/api/trpc/eventOps.snapshot*', async route => {
    const remote = await route.fetch();
    const payload = await remote.json();
    for (const item of Array.isArray(payload) ? payload : [payload]) {
      const data = item.result?.data;
      if (!data?.matches || !data.stations?.length) continue;
      const candidates = data.matches.filter((match: Match) => match.division === 'upper' && match.status === 'ready');
      const next = candidates[candidates.length - 1], later = candidates[candidates.length - 2];
      next.player1Name = 'Queued Alpha'; next.player2Name = 'Queued Beta';
      later.player1Name = 'Later Gamma'; later.player2Name = 'Later Delta';
      const stage = data.stations.find((station: { name: string }) => station.name === 'Stage');
      for (const match of data.matches) if (match.status === 'playing') { match.status = 'ready'; match.stationId = null; }
      data.stations = data.stations.map((station: { id: string; name: string }) => ({ ...station, status: 'free', currentMatchId: null }));
      data.stationQueues = data.stations.map((station: { id: string }) => ({ stationId: station.id, poolKey: null, currentMatchId: null, nextMatchId: station.id === stage.id ? next.id : null, upcoming: station.id === stage.id ? [{ matchId: later.id, round: 2 }] : [], waitingReason: null }));
    }
    await route.fulfill({ response: remote, json: payload });
  });
  await page.goto(`/overlay/${planId}?controls=0`);
  await expect(page.locator('.broadcast-topline')).toContainText('Stage');
  const pairings = page.locator('.broadcast-deck article');
  await expect(pairings).toHaveCount(2);
  await expect(pairings.nth(0)).toContainText('Queued Alpha');
  await expect(pairings.nth(0)).toContainText('Queued Beta');
  await expect(pairings.nth(0).locator('small')).toContainText('PLAY NEXT');
  await expect(pairings.nth(0)).not.toContainText('provisional');
  await expect(pairings.nth(1)).toContainText('Later Gamma');
  await expect(pairings.nth(1).locator('small')).toContainText('COMING UP · provisional');
  await page.goto(`/overlay/${planId}?station=missing-station&controls=0`);
  await expect(page.locator('.broadcast-wait')).toBeVisible();
  await expect(page.locator('.broadcast-deck article')).toHaveCount(0);
});
