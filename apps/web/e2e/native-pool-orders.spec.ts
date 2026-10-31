import { expect, test, type APIRequestContext } from '@playwright/test';
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
type Match = {
  id: string;
  player1Id: string;
  player2Id: string;
  player1Name: string;
  player2Name: string;
  revision: number;
  poolIndex: number | null;
  status: string;
  nativeBracketId: string | null;
};
type Snapshot = {
  matches: Match[];
  poolOrders: { poolIndex: number; status: string }[];
  placements: { poolIndex: number; source: string }[];
  nativeBrackets: { complete: boolean }[];
};
type Pool = {
  poolIndex: number;
  members: { playerId: string; place: number | null }[];
  placementRevision: string;
  matchRevisions: { id: string; revision: number }[];
  orderStatus: { status: string };
};
type Planner = { divisions: { division: string; pools: Pool[] }[] };

test('TO desk automatically decides a unique pool, records an explicit tied-pool ruling, then draws and completes finals', async ({
  page,
}) => {
  test.setTimeout(180_000);
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
  const { planId } = await mutate<{ planId: string }>(
    page.request,
    'admin.eventPlanner.createPlan',
    {
      name: 'Automatic pool-order rehearsal',
      bracketMode: 'native',
      structure: 'pools_finals',
      eventDate: '2026-10-22T18:30:00Z',
      rows: players.map((p, i) => ({
        lineNumber: i + 1,
        rawInput: p.canonicalName,
        cleanedName: p.canonicalName,
        playerId: p.id,
        companyId: null,
        resolutionMethod: 'manual',
      })),
    },
  );
  for (const procedure of [
    'admin.eventPlanner.freezeRoster',
    'admin.eventPlanner.generatePools',
    'eventOps.softLockPools',
  ])
    await mutate(page.request, procedure, {
      planId,
      ...(procedure === 'eventOps.softLockPools' ? { confirm: true } : {}),
    });
  await mutate(page.request, 'eventOps.settings', { planId, published: true, playerReports: true });
  const before = await query<Planner>(page.request, 'admin.eventPlanner.plan', { planId });
  const pools = before.divisions[0]!.pools;
  expect(pools).toHaveLength(2);
  let snapshot = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
  const firstPool = pools[0]!;
  const finalPoolMatch = snapshot.matches.findLast((m) => m.poolIndex === firstPool.poolIndex)!;
  for (const m of snapshot.matches.filter((m) => m.id !== finalPoolMatch.id)) {
    const p = pools.find((p) => p.poolIndex === m.poolIndex)!;
    const ids = p.members.map((member) => member.playerId);
    let firstWins = ids.indexOf(m.player1Id) < ids.indexOf(m.player2Id);
    // Pool 2 deliberately retains a three-way tie despite differing game counts.
    if (
      p.poolIndex === pools[1]!.poolIndex &&
      [m.player1Id, m.player2Id].includes(ids[0]!) &&
      [m.player1Id, m.player2Id].includes(ids[2]!)
    )
      firstWins = !firstWins;
    await mutate(page.request, 'eventOps.reportScore', {
      matchId: m.id,
      expectedRevision: m.revision,
      requestId: m.id,
      score1: firstWins ? 2 : 1,
      score2: firstWins ? 0 : 2,
      outcome: 'played',
    });
  }
  await page.goto(`/admin/event-operations?plan=${planId}`);
  await chooseOption(
    page
      .getByRole('tabpanel', { name: 'Run matches' })
      .getByRole('combobox', { name: 'View', exact: true }),
    'all',
  );
  const card = page
    .locator('article.ops-match:visible')
    .filter({ hasText: finalPoolMatch.player1Name })
    .filter({ hasText: finalPoolMatch.player2Name });
  await card.getByRole('button', { name: 'Finish match', exact: true }).click();
  const ids = firstPool.members.map((m) => m.playerId);
  const firstWins = ids.indexOf(finalPoolMatch.player1Id) < ids.indexOf(finalPoolMatch.player2Id);
  await card
    .locator('input[type="number"]')
    .nth(0)
    .fill(firstWins ? '2' : '0');
  await card
    .locator('input[type="number"]')
    .nth(1)
    .fill(firstWins ? '0' : '2');
  await card.getByRole('button', { name: 'Confirm result', exact: true }).click();
  await expect(page.locator('.ops-notice')).toContainText('Score recorded locally');
  snapshot = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
  expect(snapshot.poolOrders.map((p) => p.status)).toEqual(['automatic', 'ruling_required']);
  expect(
    snapshot.placements
      .filter((p) => p.poolIndex === firstPool.poolIndex)
      .every((p) => p.source === 'automatic'),
  ).toBe(true);
  // The old worksheet cannot overwrite the newly decided version.
  const stale = await page.request.post('/api/trpc/admin.eventPlanner.savePoolPlacements', {
    data: {
      planId,
      division: 'upper',
      pools: [
        {
          poolIndex: firstPool.poolIndex,
          playerIdsInOrder: ids,
          expectedMatchRevisions: firstPool.matchRevisions,
          expectedPlacementRevision: firstPool.placementRevision,
        },
      ],
    },
  });
  expect(stale.status()).toBe(409);
  await page.goto(`/admin/event-planner?plan=${planId}&step=pools`);
  const cards = page.locator('.pool-card');
  await expect(cards.nth(0)).toContainText('Decided automatically by distinct set-win totals');
  await expect(cards.nth(1)).toContainText('Set wins do not decide a unique full order');
  for (const [i, member] of pools[1]!.members.entries())
    await chooseOption(cards.nth(1).getByRole('combobox').nth(i), member.playerId);
  await cards.nth(1).getByRole('button', { name: 'Confirm pool', exact: true }).click();
  await expect(cards.nth(1)).toContainText('Finishing order confirmed by an organiser');
  await page.goto(`/admin/event-operations?plan=${planId}`);
  await page.getByRole('tab', { name: 'Standings / draw', exact: true }).click();
  const finals = page.locator('section.card').filter({
    has: page.getByRole('heading', { name: 'Championship and consolation', exact: true }),
  });
  await finals.getByRole('button', { name: 'Preview finals', exact: true }).click();
  await expect(finals).toContainText('Decided automatically by distinct set-win totals');
  await expect(finals).toContainText('Finishing order confirmed by an organiser');
  await finals.getByRole('button', { name: 'Create these finals', exact: true }).click();
  await expect(finals.getByRole('status')).toContainText('Finals are ready');
  for (let round = 0; round < 4; round++) {
    snapshot = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
    const ready = snapshot.matches.filter((m) => m.nativeBracketId && m.status === 'ready');
    if (!ready.length) break;
    for (const m of ready)
      await mutate(page.request, 'eventOps.reportScore', {
        matchId: m.id,
        expectedRevision: m.revision,
        requestId: crypto.randomUUID(),
        score1: 2,
        score2: 0,
        outcome: 'played',
      });
  }
  expect(snapshot.nativeBrackets.every((b) => b.complete)).toBe(true);
  await finals.getByRole('button', { name: 'Finalize native results', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(finals.getByRole('status')).toContainText('Event finalized');
});
