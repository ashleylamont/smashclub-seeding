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
  const { planId } = await mutate<{ planId: string }>(page.request, 'admin.eventPlanner.createPlan', { name, bracketMode: 'native', eventDate: new Date().toISOString(), upperTargetSize: 4, rows: roster.entries.slice(0, 8).map((entry, index) => ({ lineNumber: index + 1, rawInput: entry.playerName, cleanedName: entry.playerName, playerId: entry.playerId, companyId: entry.companyId, resolutionMethod: 'manual', divisionPreference: 'auto' })) });
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
    await page.getByLabel('Publish live event page', { exact: true }).check();
    await expect.poll(async () => (await query<{ settings: { published: boolean; scoreReportingMode: string } }>(page.request, 'eventOps.overview', { planId })).settings).toMatchObject({ published: true, scoreReportingMode: 'approve_unless_disputed' });
    await guest.reload();
    const card = guest.locator('article').filter({ has: guest.getByRole('heading', { name, exact: true }) });
    await expect(card).toBeVisible();
    expect(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await card.getByRole('link', { name: 'Open player hub' }).click();
    await expect(guest).toHaveURL(new RegExp(`/play/${planId}`));
    await expect(guest.locator('h1')).toBeVisible();
    await expect(guest.getByRole('link', { name: /Public event board/ })).toBeVisible();
    await page.getByLabel('Publish live event page', { exact: true }).uncheck();
    await expect.poll(async () => (await query<{ id: string }[]>(anonymous.request, 'eventOps.publicEvents')).some(event => event.id === planId)).toBe(false);
  } finally { await anonymous.close(); }
});
