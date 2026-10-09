import { test, expect, type APIRequestContext } from '@playwright/test';

async function query<T>(
  request: APIRequestContext,
  procedure: string,
  input: object = {},
): Promise<T> {
  const response = await request.get(`/api/trpc/${procedure}`, {
    params: { input: JSON.stringify(input) },
    timeout: 15_000,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result.data as T;
}
async function mutate<T>(request: APIRequestContext, procedure: string, data: object): Promise<T> {
  const response = await request.post(`/api/trpc/${procedure}`, { data, timeout: 15_000 });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result.data as T;
}

test('admins and assigned TOs read the same complete native history across checkpoints and closure', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  await page.request.post('/api/auth/sign-in/email', {
    data: { email: 'admin@smashclub.dev', password: 'devpassword123' },
  });
  const plans = await query<{ id: string; name: string }[]>(
    page.request,
    'admin.eventPlanner.plans',
  );
  const source = plans.find((plan) => plan.name === 'Nemesis · Rehearsal Night')!;
  const roster = await query<{
    entries: { playerId: string; playerName: string; companyId: string | null }[];
  }>(page.request, 'admin.eventPlanner.plan', { planId: source.id });
  const { planId } = await mutate<{ planId: string }>(
    page.request,
    'admin.eventPlanner.createPlan',
    {
      name: 'Native history rehearsal',
      bracketMode: 'native',
      eventDate: '2026-10-09T08:00:00.000Z',
      upperTargetSize: 6,
      rows: roster.entries.slice(0, 12).map((entry, index) => ({
        lineNumber: index + 1,
        rawInput: entry.playerName,
        cleanedName: entry.playerName,
        playerId: entry.playerId,
        companyId: entry.companyId ?? null,
        resolutionMethod: 'manual',
        divisionPreference: 'auto',
      })),
    },
  );
  for (const procedure of [
    'admin.eventPlanner.freezeRoster',
    'admin.eventPlanner.generatePools',
    'eventOps.softLockPools',
  ]) {
    await mutate(page.request, procedure, {
      planId,
      ...(procedure === 'eventOps.softLockPools' ? { confirm: true } : {}),
    });
  }
  const overview = await query<{ matches: { id: string; revision: number }[] }>(
    page.request,
    'eventOps.overview',
    { planId },
  );
  const match = overview.matches[0]!;
  await mutate(page.request, 'eventOps.reportScore', {
    matchId: match.id,
    expectedRevision: match.revision,
    requestId: 'history-result',
    score1: 2,
    score2: 0,
    outcome: 'played',
  });
  for (let index = 0; index < 52; index++) {
    await mutate(page.request, 'eventOps.announce', {
      planId,
      requestId: `history-announce-${index}`,
      message: `History announcement ${index}`,
      durationSeconds: null,
    });
  }
  await page.goto(`/admin/event-operations?plan=${planId}&view=history`);
  const history = page.getByRole('tabpanel', { name: 'History', exact: true });
  await expect(history.locator('.ops-history-entry')).toHaveCount(50);
  await history.getByRole('button', { name: 'Load older changes' }).click();
  await expect(history.getByRole('heading', { name: 'Live history started' })).toBeVisible();
  await expect(history.getByRole('heading', { name: 'Result recorded' })).toBeVisible();
  await expect(history.getByRole('button', { name: 'Load older changes' })).toHaveCount(0);
  const toContext = await browser.newContext({ baseURL });
  try {
    await toContext.request.post('/api/auth/sign-in/email', {
      data: { email: 'rehearsal-player@smashclub.dev', password: 'devpassword123' },
    });
    const forbidden = await toContext.request.get('/api/trpc/eventOps.live.history', {
      params: { input: JSON.stringify({ planId }) },
    });
    expect(forbidden.status()).toBe(403);
    await mutate(page.request, 'eventOps.assignTo', {
      planId,
      email: 'rehearsal-player@smashclub.dev',
    });
    await mutate(page.request, 'eventOps.live.command', {
      planId,
      requestId: 'history-cancel',
      command: { kind: 'cancel', reason: 'History rehearsal finished' },
    });
    const toPage = await toContext.newPage();
    await toPage.goto(`/operate/${planId}?view=history`);
    await expect(toPage.getByRole('heading', { name: 'Event cancelled' })).toBeVisible();
    await expect(toPage.getByText('History rehearsal finished', { exact: true })).toBeVisible();
    await expect(toPage.getByRole('button', { name: 'Load older changes' })).toBeEnabled();
    await page.reload();
    await expect(history.getByRole('heading', { name: 'Event cancelled' })).toBeVisible();
  } finally {
    await toContext.close();
  }
});
