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

test('signed-out player hub browses without a pass and reuses a venue pass across live-board navigation', async ({ page, browser, baseURL }, testInfo) => {
  await signIn(page.request, 'admin@smashclub.dev');
  const { planId, snapshot } = await freshEvent(page.request, 'guest hub');
  await mutate(page.request, 'eventOps.guests.configure', { planId, enabled: true, showOnOverlay: false });
  const guest = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
  try {
    const visitor = await guest.newPage();
    await visitor.goto(`/play/${planId}?pool=upper%3A0`);
    await expect(visitor.getByRole('heading', { name: 'Scan in to report a score' })).toBeVisible();
    await expect(visitor.getByLabel('Your pool')).toHaveValue('upper:0');
    await visitor.getByLabel('Player on this device').selectOption(snapshot.matches[0]!.player1Id);
    await expect(visitor.getByLabel('Match view', { exact: true })).toHaveValue('mine');
    expect(await visitor.locator('article.ops-match').count()).toBeGreaterThan(0);
    await expect(visitor.locator('article.ops-match input[type="number"]')).toHaveCount(0);
    await visitor.reload();
    await expect(visitor.getByLabel('Player on this device')).toHaveValue(snapshot.matches[0]!.player1Id);
    await expect(visitor.getByLabel('Match view', { exact: true })).toHaveValue('mine');
    await visitor.getByLabel('Player on this device').selectOption('');
    await expect(visitor.getByLabel('Match view', { exact: true })).toHaveValue('matches');
    await visitor.screenshot({ path: testInfo.outputPath('guest-no-account-mobile.png'), fullPage: true });
    expect(await visitor.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const invitation = await mutate<{ token: string }>(page.request, 'eventOps.guests.invitation', { planId });
    await visitor.goto(`/guest/${planId}?pool=upper%3A0#token=${encodeURIComponent(invitation.token)}`);
    await expect(visitor.locator('.guest-pass-expiry')).toContainText('remaining');
    await expect.poll(() => new URL(visitor.url()).hash).toBe('');
    await visitor.getByRole('link', { name: 'Live event board →', exact: true }).click();
    await expect(visitor.getByLabel('Your pool')).toHaveValue('upper:0');
    await visitor.getByRole('link', { name: 'Player area · my matches & scores →' }).click();
    await expect(visitor.locator('.guest-pass-expiry')).toContainText('remaining');
    await expect(visitor.getByLabel('Your pool')).toHaveValue('upper:0');
    await visitor.getByLabel('Match view', { exact: true }).selectOption('matches');
    await expect(visitor.locator('article.ops-match input[type="number"]').first()).toBeVisible();
    await visitor.evaluate(id => { const key = `nemesis:guest:${id}`; const pass = JSON.parse(sessionStorage.getItem(key)!); pass.expiresAt = new Date(Date.now() - 1000).toISOString(); sessionStorage.setItem(key, JSON.stringify(pass)); }, planId);
    await visitor.reload();
    await expect(visitor.getByRole('heading', { name: 'Your guest pass has expired' })).toBeVisible();
    await visitor.getByLabel('Match view', { exact: true }).selectOption('matches');
    expect(await visitor.locator('article.ops-match').count()).toBeGreaterThan(0);
    await expect(visitor.locator('article.ops-match input[type="number"]')).toHaveCount(0);
    await visitor.goto(`/guest/${planId}#token=invalid`);
    await expect(visitor.locator('.error-text')).toBeVisible();
    await expect(visitor.getByRole('heading', { name: 'Find your station', exact: true })).toBeVisible();
    await visitor.goto(`/guest/${planId}#token=${encodeURIComponent(invitation.token)}`);
    await expect(visitor.locator('.guest-pass-expiry')).toContainText('remaining');
    await mutate(page.request, 'eventOps.guests.configure', { planId, enabled: false, showOnOverlay: false });
    await expect(visitor.getByRole('heading', { name: 'Refresh your guest pass' })).toBeVisible();
    await expect(visitor.getByRole('heading', { name: 'Find your station', exact: true })).toBeVisible();
    await expect(visitor.locator('article.ops-match input[type="number"]')).toHaveCount(0);
    await mutate(page.request, 'eventOps.settings', { planId, published: false, playerReports: true });
    await expect(visitor.getByRole('alert')).toContainText('This event is unavailable or has not been published.');
    await expect(visitor.locator('article.ops-match')).toHaveCount(0);
  } finally { await guest.close(); }
});

test('QR and unlinked attendees confirm recorded results or flag a different score without overwriting it', async ({ page, browser, baseURL }, testInfo) => {
  await signIn(page.request, 'admin@smashclub.dev');
  const { planId, snapshot } = await freshEvent(page.request, 'dispute UI');
  await mutate(page.request, 'eventOps.settings', { planId, published: true, playerReports: true, scoreReportingMode: 'approve_unless_disputed' });
  await mutate(page.request, 'eventOps.guests.configure', { planId, enabled: true, showOnOverlay: false });
  const invitation = await mutate<{ token: string }>(page.request, 'eventOps.guests.invitation', { planId });
  const first = snapshot.matches.find(match => match.status === 'ready')!;
  const reporter = await browser.newContext({ baseURL });
  const second = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
  const attendee = await browser.newContext({ baseURL });
  try {
    const guest = await reporter.newPage();
    await guest.goto(`/guest/${planId}#token=${encodeURIComponent(invitation.token)}`);
    await guest.getByLabel('Match view', { exact: true }).selectOption('matches');
    const card = guest.locator('article.ops-match').filter({ hasText: first.label });
    await card.locator('input[type="number"]').nth(0).fill('2');
    await card.locator('input[type="number"]').nth(1).fill('1');
    await card.getByRole('button', { name: 'Confirm result', exact: true }).click();
    await expect(card).toContainText('Confirmed result: 2 – 1');
    const other = await second.newPage();
    await other.goto(`/guest/${planId}#token=${encodeURIComponent(invitation.token)}`);
    await other.getByLabel('Match view', { exact: true }).selectOption('results');
    const otherCard = other.locator('article.ops-match').filter({ hasText: first.label });
    await otherCard.getByRole('button', { name: 'Confirm recorded score', exact: true }).click();
    await expect(otherCard).toContainText('your score agrees');
    await otherCard.getByRole('button', { name: 'Report a different score', exact: true }).click();
    await otherCard.locator('input[type="number"]').nth(0).fill('1');
    await otherCard.locator('input[type="number"]').nth(1).fill('2');
    await otherCard.getByRole('button', { name: 'Send different score to TOs' }).click();
    await expect(otherCard).toContainText('Different score sent to the TOs for review');
    await expect(otherCard).toContainText('Confirmed result: 2 – 1');
    await other.screenshot({ path: testInfo.outputPath('guest-dispute-mobile.png'), fullPage: true });
    expect(await other.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await signIn(attendee.request, 'player@smashclub.dev');
    const signed = await attendee.newPage();
    await signed.goto(`/play/${planId}`);
    await signed.getByLabel('Match view', { exact: true }).selectOption('results');
    const signedCard = signed.locator('article.ops-match').filter({ hasText: first.label });
    await signedCard.getByRole('button', { name: 'Confirm recorded score', exact: true }).click();
    await expect(signedCard).toContainText('your score agrees');
    await signedCard.getByRole('button', { name: 'Report a different score', exact: true }).click();
    await signedCard.locator('input[type="number"]').nth(0).fill('2');
    await signedCard.locator('input[type="number"]').nth(1).fill('0');
    await signedCard.getByRole('button', { name: 'Send different score to TOs' }).click();
    await expect(signedCard).toContainText('Different score sent to the TOs for review');
    const official = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
    expect(official.matches.find(match => match.id === first.id)).toMatchObject({ status: 'complete', score1: 2, score2: 1 });
  } finally { await reporter.close(); await second.close(); await attendee.close(); }
});
