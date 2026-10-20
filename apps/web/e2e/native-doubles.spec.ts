import { test, expect, type APIRequestContext } from '@playwright/test';
import { chooseOption } from '../test-support/controls';

async function query<T>(request: APIRequestContext, procedure: string, input?: object): Promise<T> {
  const response = await request.get(`/api/trpc/${procedure}`, {
    params: input ? { input: JSON.stringify(input) } : {},
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result.data as T;
}
async function mutate<T>(request: APIRequestContext, procedure: string, data: object): Promise<T> {
  const response = await request.post(`/api/trpc/${procedure}`, { data });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result.data as T;
}

test('creates fixed doubles pairs in the planner and runs an open round robin to public team results', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(15_000);
  await page.request.post('/api/auth/sign-in/email', {
    data: { email: 'admin@smashclub.dev', password: 'devpassword123' },
  });
  const players = (
    await query<{ id: string; canonicalName: string; status: string }[]>(
      page.request,
      'admin.players',
    )
  )
    .filter((p) => p.status === 'active')
    .slice(0, 8);
  expect(players).toHaveLength(8);
  await page.goto('/admin/event-planner');
  await chooseOption(page.getByRole('combobox', { name: 'Competition', exact: true }), 'doubles');
  await page.getByLabel('Event name', { exact: true }).fill('Browser doubles rehearsal');
  await page.getByRole('button', { name: 'Create doubles plan', exact: true }).click();
  await expect(page).toHaveURL(/plan=/);
  const planId = new URL(page.url()).searchParams.get('plan')!;
  for (let i = 0; i < 4; i++) {
    for (const [button, player] of [
      ['Choose first player', players[i * 2]!],
      ['Choose partner', players[i * 2 + 1]!],
    ] as const) {
      await page.getByRole('button', { name: button, exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Search players', { exact: true }).fill(player.canonicalName);
      await dialog.getByRole('button', { name: 'Link', exact: true }).first().click();
      await expect(dialog).toBeHidden();
    }
    await page.getByLabel('Team name', { exact: true }).fill(`Team ${i + 1}`);
    await page.getByRole('button', { name: 'Add pair', exact: true }).click();
    await expect(
      page.getByRole('heading', {
        name: `Doubles roster · ${i + 1} teams / ${(i + 1) * 2} players`,
        exact: true,
      }),
    ).toBeVisible();
  }
  await expect(
    page.getByRole('combobox', { name: 'Tournament structure', exact: true }),
  ).toContainText('Open round robin');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'Freeze team seeds', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Generate pools', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Generate pools', exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 2, name: /Browser doubles rehearsal.*Pools ready/ }),
  ).toBeVisible();
  await mutate(page.request, 'eventOps.softLockPools', { planId, confirm: true });
  await mutate(page.request, 'eventOps.settings', { planId, published: true, playerReports: true });
  type State = {
    matches: { id: string; revision: number; player1Name: string; player2Name: string }[];
  };
  const state = await query<State>(page.request, 'eventOps.snapshot', { planId });
  expect(state.matches).toHaveLength(6);
  expect(
    state.matches.every((m) => m.player1Name.includes(' / ') && m.player2Name.includes(' / ')),
  ).toBe(true);
  await page.goto(`/live/${planId}`);
  await expect(
    page.getByRole('heading', { name: 'Browser doubles rehearsal', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('rowheader', { name: /^Team 1 \(/ }).first()).toBeVisible();
  for (const m of state.matches)
    await mutate(page.request, 'eventOps.reportScore', {
      matchId: m.id,
      expectedRevision: m.revision,
      requestId: crypto.randomUUID(),
      score1: 2,
      score2: 0,
      outcome: 'played',
    });
  const view = await query<{
    divisions: {
      division: string;
      pools: {
        poolIndex: number;
        members: { playerId: string }[];
        matchRevisions: { id: string; revision: number }[];
        placementRevision: string;
      }[];
    }[];
  }>(page.request, 'admin.eventPlanner.plan', { planId });
  for (const d of view.divisions)
    await mutate(page.request, 'admin.eventPlanner.savePoolPlacements', {
      planId,
      division: d.division,
      pools: d.pools.map((p) => ({
        poolIndex: p.poolIndex,
        playerIdsInOrder: p.members.map((e) => e.playerId),
        expectedMatchRevisions: p.matchRevisions,
        expectedPlacementRevision: p.placementRevision,
      })),
    });
  await page.goto(`/admin/event-operations?plan=${planId}&view=draw`);
  await expect(
    page.getByRole('heading', { name: 'Round-robin results', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Preview finals', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Finalize native results', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByText('Result revision 1 published.', { exact: false })).toBeVisible();
  const results = await query<{ id: string; slug: string; name: string }[]>(
    page.request,
    'public.tournaments',
  );
  const result = results.find((t) => t.name.startsWith('Browser doubles rehearsal'))!;
  expect(result).toBeDefined();
  await page.goto(`/events/${result.slug}`);
  await expect(page.locator('.section > .table-scroll .event-standings tbody tr')).toHaveCount(4);
  await expect(
    page
      .locator('.section > .table-scroll')
      .getByRole('columnheader', { name: 'Team', exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/No consolation bracket is linked/)).toHaveCount(0);
  await expect(page.locator('.section > .table-scroll').getByText(/^Team 1 \(/)).toBeVisible();
  await expect(page.locator('a[href*="challonge.com"]')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('native-doubles-results-mobile.png'),
    fullPage: true,
  });
});
