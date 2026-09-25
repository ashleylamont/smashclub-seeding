import { expect, test, type APIRequestContext } from '@playwright/test';
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
test('anonymous navigation finds only published events and an admin can opt into immediate score approval', async ({ page, browser, baseURL }) => {
  const signedIn = await page.request.post('/api/auth/sign-in/email', { data: { email: 'admin@smashclub.dev', password: 'devpassword123' } });
  expect(signedIn.ok()).toBe(true);
  const plans = await query<{ id: string; name: string }[]>(page.request, 'admin.eventPlanner.plans');
  const roster = await query<{ entries: { playerId: string; playerName: string; companyId: string | null }[] }>(page.request, 'admin.eventPlanner.plan', { planId: plans.find(plan => plan.name === 'Nemesis · Rehearsal Night')!.id });
  const name = `Discover event ${Date.now()}`;
  const { planId } = await mutate<{ planId: string }>(page.request, 'admin.eventPlanner.createPlan', { name, bracketMode: 'native', eventDate: new Date().toISOString(), upperTargetSize: 4, rows: roster.entries.slice(0, 8).map((entry, index) => ({ lineNumber: index + 1, rawInput: entry.playerName, cleanedName: entry.playerName, playerId: entry.playerId, companyId: entry.companyId ?? null, resolutionMethod: 'manual', divisionPreference: 'auto' })) });
  for (const procedure of ['admin.eventPlanner.freezeRoster', 'admin.eventPlanner.generatePools', 'eventOps.prepare']) await mutate(page.request, procedure, { planId });
  const anonymous = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
  try {
    const guest = await anonymous.newPage();
    await guest.goto('/');
    await guest.getByRole('link', { name: 'Event night', exact: true }).click();
    await expect(guest.getByRole('heading', { name: 'Find your event' })).toBeVisible();
    await expect(guest.getByRole('heading', { name, exact: true })).toHaveCount(0);
    await page.goto(`/admin/event-operations?plan=${planId}`);
    await expect(page.getByLabel('Event score policy')).toHaveValue('to_review');
    await page.getByLabel('Event score policy').selectOption('approve_unless_disputed');
    await expect(page.getByText('Score approval policy updated', { exact: true })).toBeVisible();
    await page.getByLabel('Publish live event page', { exact: true }).click();
    await expect(page.getByLabel('Publish live event page', { exact: true })).toBeChecked();
    await expect.poll(async () => (await query<{ settings: { published: boolean; scoreReportingMode: string } }>(page.request, 'eventOps.overview', { planId })).settings).toMatchObject({ published: true, scoreReportingMode: 'approve_unless_disputed' });
    await mutate(page.request, 'eventOps.guests.configure', { planId, enabled: true, showOnOverlay: false });
    const invitation = await mutate<{ token: string }>(page.request, 'eventOps.guests.invitation', { planId });
    const pass = await mutate<{ sessionToken: string }>(anonymous.request, 'eventOps.guests.redeem', { planId, token: invitation.token });
    const before = await query<{ matches: { id: string; revision: number; status: string }[] }>(anonymous.request, 'eventOps.snapshot', { planId });
    const match = before.matches.find(item => item.status === 'ready')!;
    await mutate(anonymous.request, 'eventOps.guests.submit', { planId, sessionToken: pass.sessionToken, matchId: match.id, expectedRevision: match.revision, requestId: crypto.randomUUID(), score1: 2, score2: 0 });
    const secondPass = await mutate<{ sessionToken: string }>(anonymous.request, 'eventOps.guests.redeem', { planId, token: invitation.token });
    const dispute = await mutate<{ isDispute: boolean; status: string }>(anonymous.request, 'eventOps.guests.submit', { planId, sessionToken: secondPass.sessionToken, matchId: match.id, expectedRevision: match.revision, requestId: crypto.randomUUID(), score1: 1, score2: 2 });
    expect(dispute).toMatchObject({ isDispute: true, status: 'pending' });
    await page.reload();
    const report = page.locator('.ops-report').filter({ hasText: 'Conflicting report' });
    await expect(report).toContainText('Recorded result:');
    await expect(report.getByRole('button', { name: 'Use submitted result' })).toBeEnabled();
    await report.getByRole('button', { name: 'Keep recorded result' }).click();
    await expect(report).toHaveCount(0);
    const after = await query<{ matches: { id: string; score1: number; score2: number; pendingDisputeCount: number }[] }>(anonymous.request, 'eventOps.snapshot', { planId });
    expect(after.matches.find(item => item.id === match.id)).toMatchObject({ score1: 2, score2: 0, pendingDisputeCount: 0 });
    await guest.reload();
    const card = guest.locator('article').filter({ has: guest.getByRole('heading', { name, exact: true }) });
    await expect(card).toBeVisible();
    expect(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await card.getByRole('link', { name: 'Open player hub' }).click();
    await expect(guest).toHaveURL(new RegExp(`/play/${planId}`));
    await expect(guest.locator('h1')).toBeVisible();
    await expect(guest.getByRole('link', { name: 'Live event board →' })).toBeVisible();
    await page.getByLabel('Publish live event page', { exact: true }).click();
    await expect(page.getByLabel('Publish live event page', { exact: true })).not.toBeChecked();
    await expect.poll(async () => (await query<{ id: string }[]>(anonymous.request, 'eventOps.publicEvents')).some(event => event.id === planId)).toBe(false);
  } finally { await anonymous.close(); }
});
