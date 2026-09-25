import { expect, test, type APIRequestContext } from '@playwright/test';

type Match = { id: string; label: string; revision: number; player1Id: string; player1Name: string; player2Name: string; status: string; division: string };
type Overview = { matches: Match[]; stations: { id: string; name: string }[]; stationQueues: { stationId: string; nextMatchId: string | null }[] };
async function query<T>(request: APIRequestContext, procedure: string, input?: object): Promise<T> {
  const response = await request.get(`/api/trpc/${procedure}`, { params: input ? { input: JSON.stringify(input) } : {} });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result.data;
}
async function mutate<T = unknown>(request: APIRequestContext, procedure: string, data: object): Promise<T> {
  const response = await request.post(`/api/trpc/${procedure}`, { data });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result.data;
}

test('TO finds an entrant, follows their current station call, and opens the exact match on a phone', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const signIn = await page.request.post('/api/auth/sign-in/email', { data: { email: 'admin@smashclub.dev', password: 'devpassword123' } });
  expect(signIn.ok()).toBe(true);
  const plans = await query<{ id: string; name: string }[]>(page.request, 'admin.eventPlanner.plans');
  const source = plans.find(plan => plan.name === 'Nemesis · Rehearsal Night')!;
  const roster = await query<{ entries: { playerId: string; playerName: string; companyId: string | null }[] }>(page.request, 'admin.eventPlanner.plan', { planId: source.id });
  const { planId } = await mutate<{ planId: string }>(page.request, 'admin.eventPlanner.createPlan', { name: `Player finder ${Date.now()}`, bracketMode: 'native', eventDate: new Date().toISOString(), upperTargetSize: 9,
    rows: roster.entries.map((entry, index) => ({ lineNumber: index + 1, rawInput: entry.playerName, cleanedName: entry.playerName, playerId: entry.playerId, companyId: entry.companyId ?? null, resolutionMethod: 'manual', divisionPreference: 'auto' })) });
  for (const procedure of ['admin.eventPlanner.freezeRoster', 'admin.eventPlanner.generatePools', 'eventOps.prepare']) await mutate(page.request, procedure, { planId });
  await mutate(page.request, 'eventOps.saveStation', { planId, name: 'Station 1' });
  let data = await query<Overview>(page.request, 'eventOps.overview', { planId });
  await mutate(page.request, 'eventOps.configurePool', { planId, division: 'upper', poolIndex: 0, active: true, stationIds: [data.stations[0]!.id], expectedRevision: 0 });
  await mutate(page.request, 'eventOps.configurePool', { planId, division: 'lower', poolIndex: 0, active: false, stationIds: [], expectedRevision: 0 });
  data = await query<Overview>(page.request, 'eventOps.overview', { planId });
  const called = data.matches.find(match => match.id === data.stationQueues[0]!.nextMatchId)!;
  await page.goto(`/admin/event-operations?plan=${planId}`);
  const finder = page.getByRole('region', { name: 'Find a player', exact: true });
  await finder.getByLabel('Player name', { exact: true }).fill(called.player1Name);
  await finder.locator('.to-player-result').filter({ has: page.getByText(called.player1Name, { exact: true }) }).click();
  await expect(finder).toContainText('Play next · Station 1');
  await expect(finder).toContainText('Upper Pool A');
  await finder.getByRole('button', { name: 'Open next match', exact: true }).click();
  await expect(page.locator('.ops-match-grid > article')).toHaveCount(1);
  await expect(page.locator('.ops-match-grid > article')).toContainText(called.label);
  await expect(page.locator('#match-desk')).toBeFocused();
  await page.getByRole('button', { name: 'Show all matches', exact: true }).click();
  expect(await page.locator('.ops-match-grid > article').count()).toBeGreaterThan(1);
  await mutate(page.request, 'eventOps.updateMatch', { matchId: called.id, expectedRevision: called.revision, status: 'playing', stationId: data.stations[0]!.id });
  await expect(finder).toContainText('Playing · Station 1');
  await expect(finder).not.toContainText('Play next ·');
  await finder.locator('summary').click();
  await expect(finder.locator('.to-player-matches')).toContainText('Playing now');
  await finder.locator('summary').click();
  await page.evaluate(() => { const panel = document.querySelector('.to-player-finder')!; window.scrollTo(0, panel.getBoundingClientRect().top + window.scrollY - 120); });
  await finder.screenshot({ path: testInfo.outputPath('to-player-finder-mobile.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const held = data.matches.find(match => match.division === 'lower')!;
  await finder.getByLabel('Player name', { exact: true }).fill(held.player1Name);
  await finder.locator('.to-player-result').filter({ has: page.getByText(held.player1Name, { exact: true }) }).click();
  await expect(finder).toContainText('On hold for a later wave');
  await finder.getByRole('button', { name: 'Lower Pool A', exact: true }).click();
  await expect(page.locator('.ops-toolbar').getByRole('combobox', { name: /^Pool/ })).toHaveValue('lower:0');
  await expect(page.locator('#match-desk')).toBeFocused();
  await expect(page.locator('.ops-match-grid')).toContainText('lower Pool A');
  await finder.getByLabel('Player name', { exact: true }).fill('definitely-no-entrant');
  await expect(finder).toContainText('No event players match that name.');
});
