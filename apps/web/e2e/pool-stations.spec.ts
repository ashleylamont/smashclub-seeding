import { expect, test, type APIRequestContext } from '@playwright/test';
type Match = { id: string; revision: number; status: string; division: string; poolIndex: number | null };
type Snapshot = { matches: Match[]; stations: { id: string; name: string }[]; poolSchedules: { division: string; poolIndex: number; active: boolean; stationIds: string[]; selfRun: boolean; autoAcceptScores: boolean }[]; stationQueues: { stationId: string; poolKey: string | null; nextMatchId: string | null }[] };
async function query<T>(request: APIRequestContext, procedure: string, input?: object): Promise<T> {
 const response = await request.get(`/api/trpc/${procedure}`, { params: input ? { input: JSON.stringify(input) } : {} });
 expect(response.ok(), await response.text()).toBe(true); return (await response.json()).result.data;
}
async function mutate<T = unknown>(request: APIRequestContext, procedure: string, data: object): Promise<T> {
 const response = await request.post(`/api/trpc/${procedure}`, { data }); expect(response.ok(), await response.text()).toBe(true); return (await response.json()).result.data;
}
test('TO divides stations once, players see pool queues, and the next wave reuses a finished bank', async ({ page }, testInfo) => {
 await page.request.post('/api/auth/sign-in/email', { data: { email: 'admin@smashclub.dev', password: 'devpassword123' } });
 const plans = await query<{ id: string; name: string }[]>(page.request, 'admin.eventPlanner.plans');
 const source = plans.find(plan => plan.name === 'Nemesis · Rehearsal Night')!;
 const roster = await query<{ entries: { playerId: string; playerName: string }[] }>(page.request, 'admin.eventPlanner.plan', { planId: source.id });
 const { planId } = await mutate<{ planId: string }>(page.request, 'admin.eventPlanner.createPlan', { name: `Pool station waves ${Date.now()}`, bracketMode: 'native', eventDate: new Date().toISOString(), upperTargetSize: 9,
 rows: roster.entries.map((entry, index) => ({ lineNumber: index + 1, rawInput: entry.playerName, cleanedName: entry.playerName, playerId: entry.playerId, companyId: null, resolutionMethod: 'manual', divisionPreference: 'auto' })) });
 for (const procedure of ['admin.eventPlanner.freezeRoster', 'admin.eventPlanner.generatePools', 'eventOps.prepare']) await mutate(page.request, procedure, { planId });
 await mutate(page.request, 'eventOps.settings', { planId, published: true, playerReports: true });
 for (const name of ['Station 10', 'Station 1', 'Station 11', 'Station 2']) await mutate(page.request, 'eventOps.saveStation', { planId, name });
 await page.goto(`/admin/event-operations?plan=${planId}`);
 await page.getByText('Divide stations between pools', { exact: true }).click();
 const setup = page.locator('.ops-pool-setup');
 await setup.getByRole('checkbox', { name: 'Accept player scores immediately in these pools' }).check();
 await setup.getByRole('button', { name: 'Review station plan', exact: true }).click();
 await expect(setup.locator('.ops-station-plan')).toContainText('Upper Pool A → Station 1 + Station 2');
 await expect(setup.locator('.ops-station-plan')).toContainText('Lower Pool A → Station 1 + Station 2');
 await setup.getByRole('button', { name: 'Apply station plan', exact: true }).click();
 await expect(page.locator('.ops-notice')).toContainText('Pool stations and round-robin queues ready');
 let snapshot = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
 expect(snapshot.poolSchedules.filter(pool => pool.active)).toHaveLength(2);
 expect(snapshot.poolSchedules.every(pool => pool.selfRun && pool.autoAcceptScores)).toBe(true);
 const upperA = snapshot.poolSchedules.find(pool => pool.division === 'upper' && pool.poolIndex === 0)!;
 expect(upperA.stationIds.map(id => snapshot.stations.find(station => station.id === id)!.name)).toEqual(['Station 1', 'Station 2']);
 expect(snapshot.stationQueues.filter(queue => queue.poolKey === 'upper:0' && queue.nextMatchId)).toHaveLength(2);
 await page.screenshot({ path: testInfo.outputPath('pool-stations-to.png'), fullPage: true });
 await page.goto(`/live/${planId}?pool=upper:0`);
 await expect(page.getByText(/^PLAY NEXT$/i).first()).toBeVisible();
 await page.setViewportSize({ width: 390, height: 844 });
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 await page.screenshot({ path: testInfo.outputPath('pool-queue-mobile.png'), fullPage: true });
 // Finish this bank's matches to exercise the TO's single wave transition.
 for (const match of snapshot.matches.filter(match => match.division === 'upper' && match.poolIndex === 0)) await mutate(page.request, 'eventOps.reportScore', { matchId: match.id, expectedRevision: match.revision, requestId: crypto.randomUUID(), score1: 2, score2: 0, outcome: 'played' });
 await page.goto(`/admin/event-operations?plan=${planId}`);
 await page.getByRole('button', { name: 'Open next pools on free stations', exact: true }).click();
 await expect(page.locator('.ops-notice')).toContainText('Next pools can play now');
 snapshot = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
 expect(snapshot.poolSchedules.find(pool => pool.division === 'upper' && pool.poolIndex === 0)!.active).toBe(false);
 expect(snapshot.poolSchedules.find(pool => pool.division === 'lower' && pool.poolIndex === 0)!.active).toBe(true);
 expect(snapshot.poolSchedules.find(pool => pool.division === 'upper' && pool.poolIndex === 1)!.active).toBe(true);
 expect(snapshot.poolSchedules.find(pool => pool.division === 'lower' && pool.poolIndex === 1)!.active).toBe(false);
});
