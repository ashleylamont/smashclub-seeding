import { expect, test, type APIRequestContext } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { chooseOption } from '../test-support/controls';

type Match = {
  id: string;
  player1Id: string | null;
  player2Id: string | null;
  nativeBracketId: string | null;
  status: string;
  outcome: string | null;
  winnerId: string | null;
  score1: number | null;
  score2: number | null;
  revision: number;
  blockedReason: string | null;
};
type Snapshot = { matches: Match[]; withdrawals: { playerId: string }[] };
type Live = {
  settings: { resourceRevision: number };
  pools: { id: string; entrantIds: string[]; qualifierRoster?: string[] }[];
  nativeBrackets: {
    id: string;
    entrantIds: string[];
    qualifierSlots?: { eligibleEntrantIds: string[] }[];
  }[];
};
async function query<T>(request: APIRequestContext, name: string, input: object): Promise<T> {
  const response = await request.get(`/api/trpc/${name}`, {
    params: { input: JSON.stringify(input) },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result.data as T;
}
async function mutate<T = unknown>(
  request: APIRequestContext,
  name: string,
  input: object,
): Promise<T> {
  const response = await request.post(`/api/trpc/${name}`, { data: input });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result.data as T;
}
const resultFacts = (match: Match) => [
  match.id,
  match.player1Id,
  match.player2Id,
  match.status,
  match.outcome,
  match.winnerId,
  match.score1,
  match.score2,
  match.revision,
];

test('a phone TO reviews restoration, handles a stale preview, preserves played/forfeit facts and frozen exclusions, and reads chronological attendance history', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const login = await page.request.post('/api/auth/sign-in/email', {
    data: { email: 'admin@smashclub.dev', password: 'devpassword123' },
  });
  expect(login.ok()).toBe(true);
  const players = (
    await query<{ id: string; canonicalName: string; status: string }[]>(
      page.request,
      'admin.players',
      {},
    )
  )
    .filter((p) => p.status === 'active')
    .slice(0, 8);
  const { planId } = await mutate<{ planId: string }>(
    page.request,
    'admin.eventPlanner.createPlan',
    {
      name: 'Reviewed attendance restoration',
      bracketMode: 'native',
      structure: 'pools_finals',
      eventDate: '2026-10-31T08:30:00Z',
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
  for (const name of [
    'admin.eventPlanner.freezeRoster',
    'admin.eventPlanner.generatePools',
    'eventOps.softLockPools',
  ])
    await mutate(page.request, name, {
      planId,
      ...(name === 'eventOps.softLockPools' ? { confirm: true } : {}),
    });
  await mutate(page.request, 'eventOps.settings', { planId, published: true, playerReports: true });
  let live = await query<Live>(page.request, 'eventOps.live.snapshot', { planId });
  await mutate(page.request, 'eventOps.live.command', {
    planId,
    requestId: 'restore-test-capacity',
    command: {
      kind: 'configureDispatch',
      capacity: 2,
      reservedStationIds: [],
      expectedResourceRevision: live.settings.resourceRevision,
    },
  });
  const target = live.pools[0]!.entrantIds[0]!;
  let snapshot = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
  const played = snapshot.matches.find((m) => [m.player1Id, m.player2Id].includes(target))!;
  await mutate(page.request, 'eventOps.reportScore', {
    matchId: played.id,
    expectedRevision: played.revision,
    requestId: 'retained-played-result',
    score1: 2,
    score2: 1,
    outcome: 'played',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/admin/event-operations?plan=${planId}&view=players`);
  await expect(page.locator('#attendee-list tbody tr')).toHaveCount(8);
  const controls = page.locator('section.card').filter({
    has: page.getByRole('heading', { name: 'Attendance changes', exact: true }),
  });
  await chooseOption(controls.getByRole('combobox', { name: 'Change', exact: true }), 'withdraw');
  await chooseOption(controls.getByRole('combobox', { name: 'Player', exact: true }), target);
  await controls
    .getByLabel('Reason', { exact: true })
    .fill('Accidentally selected the wrong entrant');
  await controls.getByRole('button', { name: 'Preview attendance change', exact: true }).click();
  await controls.getByRole('button', { name: 'Apply this change', exact: true }).click();
  await expect(
    controls.getByText(
      'Attendance updated. Refresh the match queue to see the current pools and matches.',
      { exact: true },
    ),
  ).toBeVisible();
  snapshot = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
  expect(snapshot.withdrawals.some((w) => w.playerId === target)).toBe(true);
  const blocked = snapshot.matches.filter(
    (m) => m.status !== 'complete' && [m.player1Id, m.player2Id].includes(target),
  );
  expect(blocked).toHaveLength(2);
  const forfeited = blocked[0]!,
    future = blocked[1]!;
  await mutate(page.request, 'eventOps.reportScore', {
    matchId: forfeited.id,
    expectedRevision: forfeited.revision,
    requestId: 'retained-explicit-forfeit',
    score1: 0,
    score2: 0,
    outcome: 'forfeit',
    winnerId: forfeited.player1Id === target ? forfeited.player2Id : forfeited.player1Id,
  });
  const draw = await query<{ allowed: boolean; revisionToken: string }>(
    page.request,
    'eventOps.native.preview',
    { planId },
  );
  expect(draw.allowed).toBe(true);
  await mutate(page.request, 'eventOps.native.generate', {
    planId,
    revisionToken: draw.revisionToken,
  });
  live = await query<Live>(page.request, 'eventOps.live.snapshot', { planId });
  const field = live.pools.map((pool) => [pool.id, pool.qualifierRoster]);
  expect(live.pools[0]!.qualifierRoster).not.toContain(target);
  snapshot = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
  const playedFacts = resultFacts(snapshot.matches.find((m) => m.id === played.id)!);
  const forfeitFacts = resultFacts(snapshot.matches.find((m) => m.id === forfeited.id)!);

  await chooseOption(controls.getByRole('combobox', { name: 'Change', exact: true }), 'restore');
  await chooseOption(controls.getByRole('combobox', { name: 'Player', exact: true }), target);
  await expect(
    controls.getByRole('button', { name: 'Preview attendance change', exact: true }),
  ).toBeDisabled();
  await controls
    .getByLabel('Reason', { exact: true })
    .fill('Returned; preserve the recorded forfeit and fixed field');
  await controls.getByRole('button', { name: 'Preview attendance change', exact: true }).click();
  const impact = controls.getByRole('region', { name: 'Restoration consequences', exact: true });
  await expect(impact).toContainText('This entrant was excluded when the finals field was frozen');
  await expect(impact).toContainText('Can resume');
  await expect(impact).toContainText('Result retained');
  await expect(impact).toContainText('separate organiser ruling');
  await expect(impact).toContainText('Reserved sources stay fixed');
  await page.screenshot({
    path: testInfo.outputPath('restore-reviewed-impact-phone.png'),
    fullPage: true,
  });
  // The same reviewed action must be previewed again when current resources change.
  await mutate(page.request, 'eventOps.live.command', {
    planId,
    requestId: 'restore-preview-went-stale',
    command: {
      kind: 'configureDispatch',
      capacity: 3,
      reservedStationIds: [],
      expectedResourceRevision: live.settings.resourceRevision,
    },
  });
  await controls.getByRole('button', { name: 'Apply this change', exact: true }).click();
  await expect(controls.getByRole('alert')).toContainText('changed since this preview');
  expect(
    (await query<Snapshot>(page.request, 'eventOps.snapshot', { planId })).withdrawals.some(
      (w) => w.playerId === target,
    ),
  ).toBe(true);
  await controls.getByRole('button', { name: 'Preview attendance change', exact: true }).click();
  await expect(controls.getByRole('alert')).toHaveCount(0);
  await controls.getByRole('button', { name: 'Apply this change', exact: true }).click();
  await expect(
    controls.getByText(
      'Attendance restored. Recorded results and any frozen finals field stay unchanged.',
      { exact: true },
    ),
  ).toBeVisible();
  snapshot = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
  expect(snapshot.withdrawals.some((w) => w.playerId === target)).toBe(false);
  expect(resultFacts(snapshot.matches.find((m) => m.id === played.id)!)).toEqual(playedFacts);
  expect(resultFacts(snapshot.matches.find((m) => m.id === forfeited.id)!)).toEqual(forfeitFacts);
  expect(snapshot.matches.find((m) => m.id === future.id)).toMatchObject({
    status: 'ready',
    blockedReason: null,
    revision: future.revision + 1,
    player1Id: future.player1Id,
    player2Id: future.player2Id,
  });
  const after = await query<Live>(page.request, 'eventOps.live.snapshot', { planId });
  expect(after.pools.map((pool) => [pool.id, pool.qualifierRoster])).toEqual(field);
  expect(after.nativeBrackets.every((bracket) => !bracket.entrantIds.includes(target))).toBe(true);
  await expect(
    controls.getByRole('heading', { name: 'Attendance history', exact: true }),
  ).toBeVisible();
  const history = controls.getByRole('list', { name: 'Recorded attendance changes', exact: true });
  await expect(history.locator(':scope > li')).toHaveCount(2);
  await expect(history.locator(':scope > li').nth(0)).toContainText(
    'Accidentally selected the wrong entrant',
  );
  const restored = history.locator(':scope > li').nth(1);
  await expect(restored).toContainText('Entrant restored');
  await expect(restored).toContainText('Returned; preserve the recorded forfeit and fixed field');
  await expect(restored).toContainText('TO / admin');
  expect(await restored.locator('time').getAttribute('datetime')).toBeTruthy();
  const historyData = await query<{ entries: { title: string; actor: string }[] }>(
    page.request,
    'eventOps.live.history',
    { planId },
  );
  await expect(restored).toContainText(
    historyData.entries.find((e) => e.title === 'Entrant restored')!.actor,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
  ).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath('restore-attendance-history-phone.png'),
    fullPage: true,
  });
});
