import { test, expect, type APIRequestContext } from '@playwright/test';

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

test('adopt a completed night with changed attendance, without rewriting the plan or imported results', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const login = await page.request.post('/api/auth/sign-in/email', { data: { email: 'admin@smashclub.dev', password: 'devpassword123' } });
  expect(login.ok()).toBe(true);
  const plans = await query<Array<{ id: string; name: string; entryCount: number }>>(page.request, 'admin.eventPlanner.plans');
  const plan = plans.find(plan => plan.name === 'Nemesis · Historical Rehearsal')!;
  expect(plan).toBeTruthy();
  expect(plan.entryCount).toBe(8);
  const input = { planId: plan.id };
  type Plan = { entries: unknown[]; plan: { status: string; historicalAdoption: unknown }; brackets: Array<{ tournamentId: string | null }> };
  const original = await query<Plan>(page.request, 'admin.eventPlanner.plan', input);
  expect(original.brackets.filter(bracket => bracket.tournamentId)).toHaveLength(2);
  const candidates = await query<Array<{ tournamentId: string; slug: string }>>(page.request, 'admin.eventPlanner.historicalCandidates', input);
  const selections = (['upper', 'lower'] as const).flatMap(division => (['main', 'consolation'] as const).map(stage => {
    const slug = `historical_rehearsal_${division}_${stage}`;
    return { division, stage, tournamentId: candidates.find(candidate => candidate.slug === slug)!.tournamentId, slug };
  }));
  const importsBefore = await Promise.all(selections.map(({ slug }) => query(page.request, 'public.tournament', { slug })));
  await page.goto(`/admin/event-planner?plan=${plan.id}`);
  await page.getByRole('button', { name: 'Choose historical brackets', exact: true }).click();
  for (const choice of selections) {
    await page.getByLabel(`${choice.division === 'upper' ? 'Upper' : 'Lower'} ${choice.stage}`, { exact: true }).selectOption(choice.tournamentId);
  }
  await page.getByRole('button', { name: 'Preview historical adoption', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review the event as played' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Planned, absent from imported brackets (1)', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'In imported brackets, absent from plan (1)', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Changed division (2)', exact: true })).toBeVisible();
  expect((await query<Plan>(page.request, 'admin.eventPlanner.plan', input)).brackets.filter(bracket => bracket.tournamentId)).toHaveLength(2);
  // A changed selection invalidates the reviewed preview immediately.
  await page.getByLabel('Upper consolation', { exact: true }).selectOption('');
  await expect(page.getByRole('button', { name: 'Adopt these historical results', exact: true })).toHaveCount(0);
  await page.getByLabel('Upper consolation', { exact: true }).selectOption(selections.find(choice => choice.division === 'upper' && choice.stage === 'consolation')!.tournamentId);
  await page.getByRole('button', { name: 'Preview historical adoption', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Adopt these historical results', exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('historical-adoption-preview.png'), fullPage: true });

  // Another admin applying the same repair makes the displayed preview stale.
  const brackets = selections.map(({ division, stage, tournamentId }) => ({ division, stage, tournamentId }));
  const preview = await mutate<{ fingerprint: string }>(page.request, 'admin.eventPlanner.previewHistoricalAdoption', { ...input, brackets });
  await mutate(page.request, 'admin.eventPlanner.applyHistoricalAdoption', { ...input, brackets, fingerprint: preview.fingerprint });
  await page.getByRole('button', { name: 'Adopt these historical results', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Preview the adoption again');
  await expect(page.getByRole('button', { name: 'Adopt these historical results', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Preview historical adoption', exact: true }).click();
  await page.getByRole('button', { name: 'Adopt these historical results', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Historical results adopted', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Run event →', exact: true })).toHaveCount(0);
  await expect(page.getByText('Original plan — may differ from the event played', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('historical-adoption-complete.png'), fullPage: true });

  const adopted = await query<Plan>(page.request, 'admin.eventPlanner.plan', input);
  expect(adopted.plan.status).toBe('complete');
  expect(adopted.plan.historicalAdoption).toBeTruthy();
  expect(adopted.entries).toEqual(original.entries);
  expect((await query<{ matches: unknown[] }>(page.request, 'eventOps.snapshot', input)).matches).toEqual([]);
  expect(await Promise.all(selections.map(({ slug }) => query(page.request, 'public.tournament', { slug })))).toEqual(importsBefore);
  for (const { slug } of selections) {
    const overview = await query<{ brackets: Array<{ tournamentId: string }> }>(page.request, 'public.eventOverview', { slug });
    expect(overview.brackets.map(bracket => bracket.tournamentId).sort()).toEqual(selections.map(choice => choice.tournamentId).sort());
  }
  await page.getByRole('link', { name: 'View imported results →', exact: true }).click();
  await expect(page.getByText(/4 brackets/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Upper standings' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Lower standings' })).toBeVisible();
  for (const route of ['live', 'overlay']) {
    await page.goto(`/${route}/${plan.id}`);
    await expect(page.getByRole('link', { name: 'View historical results →', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Confirmed pool standings' })).toHaveCount(0);
    await expect(page.getByText('Next challengers', { exact: false })).toHaveCount(0);
  }
});
