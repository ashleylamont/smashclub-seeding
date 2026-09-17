import { test, expect, type APIRequestContext } from '@playwright/test';

type Match = { id: string; division: string; poolIndex: number; player1Id: string; player2Id: string; status: string; revision: number; score1: number | null; score2: number | null; winnerId: string | null; blockedReason: string | null };
type Snapshot = { matches: Match[]; withdrawals: Array<{ playerId: string }> };
type Entry = { playerId: string; playerName: string; publicName: string | null; companyId?: string | null };
type Plan = { entries: Entry[]; divisions: Array<{ division: string; pools: Array<{ poolIndex: number; members: Array<{ playerId: string }> }> }> };
async function query<T>(request: APIRequestContext, name: string, input?: object): Promise<T> {
  const response = await request.get(`/api/trpc/${name}`, { params: input ? { input: JSON.stringify(input) } : {} });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result.data as T;
}
async function mutate<T>(request: APIRequestContext, name: string, input: object): Promise<T> {
  const response = await request.post(`/api/trpc/${name}`, { data: input });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result.data as T;
}

test('attendance preview preserves completed play, rejects stale changes, and holds withdrawals', async ({ page }) => {
  test.setTimeout(120_000);
  const login = await page.request.post('/api/auth/sign-in/email', { data: { email: 'admin@smashclub.dev', password: 'devpassword123' } });
  expect(login.ok()).toBe(true);
  const plans = await query<Array<{ id: string; name: string }>>(page.request, 'admin.eventPlanner.plans');
  const source = plans.find(plan => plan.name === 'Nemesis · Rehearsal Night')!;
  const original = await query<Plan>(page.request, 'admin.eventPlanner.plan', { planId: source.id });
  const latePlayer = original.entries[16]!;
  const { planId } = await mutate<{ planId: string }>(page.request, 'admin.eventPlanner.createPlan', {
    name: `Attendance browser rehearsal ${Date.now()}`, eventDate: new Date().toISOString(), upperTargetSize: 8,
    rows: original.entries.slice(0, 16).map((entry, index) => ({ lineNumber: index + 1, rawInput: entry.playerName, cleanedName: entry.playerName,
      playerId: entry.playerId, companyId: entry.companyId ?? null, resolutionMethod: 'manual', divisionPreference: 'auto' })),
  });
  for (const operation of ['admin.eventPlanner.freezeRoster', 'admin.eventPlanner.generatePools', 'eventOps.prepare']) await mutate(page.request, operation, { planId });
  const before = await query<Snapshot>(page.request, 'eventOps.overview', { planId });
  const played = before.matches.find(match => match.division === 'upper' && match.poolIndex === 0)!;
  await mutate(page.request, 'eventOps.reportScore', { matchId: played.id, expectedRevision: played.revision, requestId: crypto.randomUUID(), score1: 2, score2: 1, outcome: 'played' });
  const frozen = await query<Plan>(page.request, 'admin.eventPlanner.plan', { planId });
  await page.goto(`/admin/event-operations?plan=${planId}`);
  const attendance = page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Late arrivals and withdrawals', exact: true }) });
  await attendance.getByLabel('Find player by public alias', { exact: true }).fill(latePlayer.publicName ?? latePlayer.playerName);
  await expect(attendance.getByRole('combobox', { name: 'Player', exact: true }).locator(`option[value="${latePlayer.playerId}"]`)).toHaveCount(1);
  await attendance.getByRole('combobox', { name: 'Player', exact: true }).selectOption(latePlayer.playerId);
  await attendance.getByRole('combobox', { name: 'Pool', exact: true }).selectOption('upper:0');
  await attendance.getByRole('button', { name: 'Preview attendance change' }).click();
  await expect(attendance.locator('.ops-attendance-preview')).toContainText('4 new match(es)');
  await attendance.getByRole('button', { name: 'Apply this change' }).click();
  await expect(attendance.getByRole('status')).toContainText('Completed results were preserved');

  const afterAdd = await query<Snapshot>(page.request, 'eventOps.overview', { planId });
  expect(afterAdd.matches).toHaveLength(before.matches.length + 4);
  expect(afterAdd.matches.find(match => match.id === played.id)).toMatchObject({ status: 'complete', score1: 2, score2: 1, winnerId: played.player1Id });
  const allocated = await query<Plan>(page.request, 'admin.eventPlanner.plan', { planId });
  for (const division of frozen.divisions) for (const pool of division.pools) {
    const current = allocated.divisions.find(d => d.division === division.division)!.pools.find(p => p.poolIndex === pool.poolIndex)!;
    expect(current.members.filter(member => member.playerId !== latePlayer.playerId).map(member => member.playerId)).toEqual(pool.members.map(member => member.playerId));
  }

  await attendance.getByRole('combobox', { name: 'Change', exact: true }).selectOption('withdraw');
  await attendance.getByRole('combobox', { name: 'Player', exact: true }).selectOption(played.player1Id);
  await attendance.getByLabel('Reason', { exact: true }).fill('Needs to leave early');
  await attendance.getByRole('button', { name: 'Preview attendance change' }).click();
  await expect(attendance.locator('.ops-attendance-preview')).toBeVisible();
  // Another TO changes the queue after this preview; the UI must not apply it.
  const changed = afterAdd.matches.find(match => match.status === 'ready')!;
  await mutate(page.request, 'eventOps.updateMatch', { matchId: changed.id, expectedRevision: changed.revision, status: 'playing' });
  await attendance.getByRole('button', { name: 'Apply this change' }).click();
  await expect(attendance.getByRole('alert')).toContainText('event changed since this preview');
  expect((await query<Snapshot>(page.request, 'eventOps.overview', { planId })).withdrawals).toHaveLength(0);

  await attendance.getByRole('button', { name: 'Preview attendance change' }).click();
  await expect(attendance.getByRole('alert')).toHaveCount(0);
  await attendance.getByRole('button', { name: 'Apply this change' }).click();
  await expect(attendance.getByRole('status')).toContainText('Attendance updated');
  const withdrawn = await query<Snapshot>(page.request, 'eventOps.overview', { planId });
  expect(withdrawn.withdrawals).toEqual(expect.arrayContaining([expect.objectContaining({ playerId: played.player1Id })]));
  expect(withdrawn.matches.find(match => match.id === played.id)).toMatchObject({ status: 'complete', score1: 2, score2: 1, winnerId: played.player1Id });
  const remaining = withdrawn.matches.filter(match => match.id !== played.id && [match.player1Id, match.player2Id].includes(played.player1Id));
  expect(remaining.length).toBeGreaterThan(0);
  for (const match of remaining) expect(match).toMatchObject({ status: 'blocked', score1: null, score2: null, winnerId: null });
});
