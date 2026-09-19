import { expect, test } from '@playwright/test';

test('public night board and user-initiated overlay capture controls', async ({ page }, testInfo) => {
  const signIn = await page.request.post('/api/auth/sign-in/email', { data: { email: 'admin@smashclub.dev', password: 'devpassword123' } });
  expect(signIn.ok()).toBe(true);
  const response = await page.request.get('/api/trpc/admin.eventPlanner.plans');
  const plans = (await response.json()).result.data as { id: string; name: string }[];
  const plan = plans.find(item => item.name === 'Nemesis · Rehearsal Night')!;
  expect(plan).toBeTruthy();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/live/${plan.id}`);
  await expect(page.getByRole('heading', { name: 'Find your station', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Pool progress & standings' })).toBeVisible();
  await page.getByText('More playing and ready matches', { exact: true }).click();
  await expect(page.getByRole('heading', { name: /Ready to play/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('event-board-mobile.png'), fullPage: true });
  await page.addInitScript(() => {
    const state = { calls: [] as string[], tracks: [] as MediaStreamTrack[], stopped: 0 };
    Object.assign(window, { __captureTest: state });
    const create = (kind: string) => {
      state.calls.push(kind);
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      canvas.getContext('2d')!.fillRect(0, 0, 640, 360);
      const stream = canvas.captureStream(1);
      for (const track of stream.getTracks()) {
        const stop = track.stop.bind(track);
        track.stop = () => { state.stopped++; stop(); };
        state.tracks.push(track);
      }
      return Promise.resolve(stream);
    };
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: (constraints: DisplayMediaStreamOptions) => { if (constraints.audio !== false) throw new Error('Audio must remain disabled'); return create('screen'); } });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: (constraints: MediaStreamConstraints) => { if (constraints.audio !== false) throw new Error('Audio must remain disabled'); return create('camera'); } });
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`/overlay/${plan.id}?station=Stage&controls=0`);
  await expect(page.getByLabel('Transparent game capture area')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __captureTest: { calls: string[] } }).__captureTest.calls)).toEqual([]);
  await expect(page.getByRole('button', { name: 'Display setup' })).toHaveCount(0);
  await page.keyboard.press('s');
  const controls = page.getByRole('region', { name: 'Overlay display setup' });
  await expect(controls).toBeVisible();
  await expect(controls).toContainText('above');
  await controls.getByLabel('Current match station').selectOption({ label: 'Setup 2' });
  expect(new URL(page.url()).searchParams.get('station')).toBeTruthy();
  await expect(page.locator('.broadcast-topline')).toContainText('Setup 2');
  await controls.getByText('Show video directly in this browser', { exact: true }).click();
  await controls.getByRole('button', { name: 'Choose window / screen' }).click();
  await expect(page.getByLabel('Local game capture video', { exact: true })).toBeVisible();
  await expect(controls.getByRole('status')).toContainText('Shared window / screen is showing');
  await controls.getByRole('button', { name: 'Open selected video input' }).click();
  await expect(controls.getByRole('status')).toContainText('Camera / capture card is showing');
  expect(await page.evaluate(() => (window as unknown as { __captureTest: { stopped: number } }).__captureTest.stopped)).toBe(1);
  await controls.getByRole('button', { name: 'Stop and close capture' }).click();
  await expect(page.getByLabel('Transparent game capture area')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __captureTest: { stopped: number } }).__captureTest.stopped)).toBe(2);
  await controls.getByRole('button', { name: 'Hide controls' }).click();
  await expect(controls).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('overlay-station-screen.png') });
});

test('public bracket rounds show byes, dependencies, mains and scheduling holds', async ({ page }) => {
  await page.request.post('/api/auth/sign-in/email', { data: { email: 'admin@smashclub.dev', password: 'devpassword123' } });
  const response = await page.request.get('/api/trpc/admin.eventPlanner.plans');
  const plans = (await response.json()).result.data as { id: string; name: string }[];
  const plan = plans.find(item => item.name === 'Nemesis · Rehearsal Night')!;
  await page.route('**/api/trpc/eventOps.snapshot*', async route => {
    const remote = await route.fetch();
    const payload = await remote.json();
    for (const item of Array.isArray(payload) ? payload : [payload]) {
      const data = item.result?.data;
      if (!data?.matches || !data.entrants) continue;
      const first = data.entrants[0], second = data.entrants[1];
      const base = { ...data.matches[0], division: 'upper', stage: 'main', poolIndex: null, nativeBracketId: 'native-demo', score1: null, score2: null, winnerId: null, stationId: null, player1Characters: ['mario'], player2Characters: [], parent1MatchId: null, parent2MatchId: null };
      data.nativeBrackets = [{ id: 'native-demo', division: 'upper', stage: 'main', entrantIds: [first.id, second.id], complete: false, winnerId: null, standings: [] }, { id: 'no-contest', division: 'lower', stage: 'main', entrantIds: [first.id, second.id], complete: true, winnerId: null, standings: [] }, { id: 'empty', division: 'lower', stage: 'consolation', entrantIds: [], complete: true, winnerId: null, standings: [] }];
      data.poolSchedules = [{ division: 'upper', poolIndex: 0, active: false, stationIds: [] }];
      for (const match of data.matches) if (match.division === 'upper' && match.poolIndex === 0 && match.status === 'ready') match.availability = { canStart: false, reasons: [{ code: 'pool_held', message: 'Pool on hold' }], eligibleStationIds: [] };
      data.matches.push(
        { ...base, id: 'native-semi', label: 'Upper semi A', nativeRound: 1, nativeSlot: 0, player1Id: first.id, player1Name: first.name, player2Id: null, player2Name: null, outcome: 'bye', status: 'complete', winnerId: first.id },
        { ...base, id: 'native-final', label: 'Upper final', nativeRound: 2, nativeSlot: 0, player1Id: first.id, player1Name: first.name, player2Id: null, player2Name: null, parent2MatchId: 'native-other-semi', status: 'blocked' },
        { ...base, id: 'native-other-semi', label: 'Upper semi B', nativeRound: 1, nativeSlot: 1, player1Id: second.id, player1Name: second.name, player2Id: null, player2Name: null, status: 'blocked' },
      );
    }
    await route.fulfill({ response: remote, json: payload });
  });
  await page.goto(`/live/${plan.id}`);
  const brackets = page.locator('.event-brackets');
  await expect(brackets.getByRole('heading', { name: 'upper · Championship' })).toBeVisible();
  await expect(brackets.getByRole('heading', { name: 'Semi-finals', exact: true })).toBeVisible();
  await expect(brackets.getByRole('heading', { name: 'Final', exact: true })).toBeVisible();
  await expect(brackets).toContainText('Winner of Upper semi B');
  await expect(brackets).toContainText('No champion — remaining entrants withdrew; no contest.');
  await expect(brackets).toContainText('Empty bracket — no entrants.');
  await expect(brackets).toContainText('Upper semi A · Bye');
  await expect(brackets.getByRole('img', { name: 'Mains Mario', exact: true }).first()).toBeVisible();
  const heldPool = page.locator('.event-pool').filter({ hasText: 'upper · Pool A' });
  await expect(heldPool).toContainText('On hold');
});
