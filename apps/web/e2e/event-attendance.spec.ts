import { chooseOption } from '../test-support/controls';
import { test, expect, type APIRequestContext } from '@playwright/test';

type Match = {
  id: string;
  division: string;
  poolIndex: number;
  player1Id: string;
  player2Id: string;
  status: string;
  revision: number;
  score1: number | null;
  score2: number | null;
  winnerId: string | null;
  blockedReason: string | null;
};
type Snapshot = { matches: Match[]; withdrawals: { playerId: string }[] };
type Entry = {
  playerId: string;
  playerName: string;
  publicName: string | null;
  companyId?: string | null;
};
type Plan = {
  entries: Entry[];
  divisions: {
    division: string;
    pools: { poolIndex: number; members: { playerId: string }[] }[];
  }[];
};
async function query<T>(request: APIRequestContext, name: string, input?: object): Promise<T> {
  const response = await request.get(`/api/trpc/${name}`, {
    params: input ? { input: JSON.stringify(input) } : {},
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result.data as T;
}
async function mutate<T>(request: APIRequestContext, name: string, input: object): Promise<T> {
  const response = await request.post(`/api/trpc/${name}`, { data: input });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result.data as T;
}

async function prepareAttendanceEvent(
  request: APIRequestContext,
  bracketMode: 'native' | 'challonge',
) {
  const login = await request.post('/api/auth/sign-in/email', {
    data: { email: 'admin@smashclub.dev', password: 'devpassword123' },
  });
  expect(login.ok()).toBe(true);
  const plans = await query<{ id: string; name: string }[]>(request, 'admin.eventPlanner.plans');
  const source = plans.find((plan) => plan.name === 'Nemesis · Rehearsal Night')!;
  const original = await query<Plan>(request, 'admin.eventPlanner.plan', {
    planId: source.id,
  });
  const latePlayer = original.entries[16]!;
  const { planId } = await mutate<{ planId: string }>(request, 'admin.eventPlanner.createPlan', {
    name: `Attendance ${bracketMode} rehearsal ${Date.now()}`,
    bracketMode,
    eventDate: new Date().toISOString(),
    upperTargetSize: 8,
    rows: original.entries.slice(0, 16).map((entry, index) => ({
      lineNumber: index + 1,
      rawInput: entry.playerName,
      cleanedName: entry.playerName,
      playerId: entry.playerId,
      companyId: entry.companyId ?? null,
      resolutionMethod: 'manual',
      divisionPreference: 'auto',
    })),
  });
  for (const operation of ['admin.eventPlanner.freezeRoster', 'admin.eventPlanner.generatePools'])
    await mutate(request, operation, { planId });
  await mutate(request, 'eventOps.softLockPools', { planId, confirm: true });
  await mutate(request, 'eventOps.saveStation', { planId, name: 'Attendance station' });
  await mutate(request, 'eventOps.prepare', { planId });
  return { planId, latePlayer };
}

test('attendance preview preserves completed play, rejects stale changes, and holds withdrawals', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { planId, latePlayer } = await prepareAttendanceEvent(page.request, 'native');
  const before = await query<Snapshot>(page.request, 'eventOps.overview', { planId });
  const played = before.matches.find(
    (match) => match.division === 'upper' && match.poolIndex === 0,
  )!;
  await mutate(page.request, 'eventOps.reportScore', {
    matchId: played.id,
    expectedRevision: played.revision,
    requestId: crypto.randomUUID(),
    score1: 2,
    score2: 1,
    outcome: 'played',
  });
  const frozen = await query<Plan>(page.request, 'admin.eventPlanner.plan', { planId });
  await page.goto(`/admin/event-operations?plan=${planId}`);
  await page.getByRole('tab', { name: 'Players', exact: true }).click();
  // The roster loads separately above these controls. Wait for its rows so its
  // arrival cannot move an open player menu out of the viewport.
  await expect(page.locator('#attendee-list tbody tr')).toHaveCount(16);
  const attendance = page.locator('section.card').filter({
    has: page.getByRole('heading', { name: 'Attendance changes', exact: true }),
  });
  await attendance
    .getByLabel('Find player by public alias', { exact: true })
    .fill(latePlayer.publicName ?? latePlayer.playerName);
  await attendance.getByRole('combobox', { name: 'Player', exact: true }).click();
  await expect(
    page.getByRole('option').filter({ hasText: latePlayer.publicName ?? latePlayer.playerName }),
  ).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toBeHidden();
  await expect(attendance.getByRole('combobox', { name: 'Player', exact: true })).toBeFocused();
  await chooseOption(
    attendance.getByRole('combobox', { name: 'Player', exact: true }),
    latePlayer.playerId,
  );
  await attendance.getByRole('button', { name: 'Preview attendance change' }).click();
  await expect(attendance.locator('.ops-attendance-preview')).toContainText('4 new match(es)');
  await expect(attendance.getByRole('checkbox', { name: /Challonge bracket/ })).toHaveCount(0);
  await attendance.getByRole('button', { name: 'Apply this change' }).click();
  await expect(attendance.getByRole('status')).toContainText('Attendance updated');

  const afterAdd = await query<Snapshot>(page.request, 'eventOps.overview', { planId });
  expect(afterAdd.matches).toHaveLength(before.matches.length + 4);
  expect(afterAdd.matches.find((match) => match.id === played.id)).toMatchObject({
    status: 'complete',
    score1: 2,
    score2: 1,
    winnerId: played.player1Id,
  });
  const allocated = await query<Plan>(page.request, 'admin.eventPlanner.plan', { planId });
  for (const division of frozen.divisions)
    for (const pool of division.pools) {
      const current = allocated.divisions
        .find((d) => d.division === division.division)!
        .pools.find((p) => p.poolIndex === pool.poolIndex)!;
      expect(
        current.members
          .filter((member) => member.playerId !== latePlayer.playerId)
          .map((member) => member.playerId),
      ).toEqual(pool.members.map((member) => member.playerId));
    }

  await chooseOption(attendance.getByRole('combobox', { name: 'Change', exact: true }), 'withdraw');
  await chooseOption(
    attendance.getByRole('combobox', { name: 'Player', exact: true }),
    played.player1Id,
  );
  await attendance.getByLabel('Reason', { exact: true }).fill('Needs to leave early');
  await attendance.getByRole('button', { name: 'Preview attendance change' }).click();
  await expect(attendance.locator('.ops-attendance-preview')).toBeVisible();
  // Another TO changes the queue after this preview; the UI must not apply it.
  const changed = afterAdd.matches.find((match) => match.status === 'ready')!;
  await mutate(page.request, 'eventOps.updateMatch', {
    matchId: changed.id,
    expectedRevision: changed.revision,
    status: 'playing',
  });
  await attendance.getByRole('button', { name: 'Apply this change' }).click();
  await expect(attendance.getByRole('alert')).toContainText('event changed since this preview');
  expect(
    (await query<Snapshot>(page.request, 'eventOps.overview', { planId })).withdrawals,
  ).toHaveLength(0);

  await attendance.getByRole('button', { name: 'Preview attendance change' }).click();
  await expect(attendance.getByRole('alert')).toHaveCount(0);
  await attendance.getByRole('button', { name: 'Apply this change' }).click();
  await expect(attendance.getByRole('status')).toContainText('Attendance updated');
  const withdrawn = await query<Snapshot>(page.request, 'eventOps.overview', { planId });
  expect(withdrawn.withdrawals).toEqual(
    expect.arrayContaining([expect.objectContaining({ playerId: played.player1Id })]),
  );
  expect(withdrawn.matches.find((match) => match.id === played.id)).toMatchObject({
    status: 'complete',
    score1: 2,
    score2: 1,
    winnerId: played.player1Id,
  });
  const remaining = withdrawn.matches.filter(
    (match) =>
      match.id !== played.id && [match.player1Id, match.player2Id].includes(played.player1Id),
  );
  expect(remaining.length).toBeGreaterThan(0);
  for (const match of remaining)
    expect(match).toMatchObject({ status: 'blocked', score1: null, score2: null, winnerId: null });
});

test('linked attendance requires a fresh acknowledgement after previewing each change', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { planId } = await prepareAttendanceEvent(page.request, 'challonge');
  await mutate(page.request, 'admin.eventPlanner.attachBracket', {
    planId,
    division: 'upper',
    stage: 'main',
    challongeSlug: `linked-attendance-${planId}`,
  });
  const plan = await query<Plan>(page.request, 'admin.eventPlanner.plan', { planId });
  const [first, second] = plan.divisions.find((division) => division.division === 'upper')!
    .pools[0]!.members;
  const previewInput = { planId, action: 'withdraw', playerId: first!.playerId };
  expect(await query(page.request, 'eventOps.previewAttendance', previewInput)).toMatchObject({
    allowed: true,
    requiresExternalAcknowledgement: true,
  });

  await page.goto(`/admin/event-operations?plan=${planId}&view=players`);
  const attendance = page.locator('section.card').filter({
    has: page.getByRole('heading', { name: 'Attendance changes', exact: true }),
  });
  const action = attendance.getByRole('combobox', { name: 'Change', exact: true });
  const player = attendance.getByRole('combobox', { name: 'Player', exact: true });
  const preview = attendance.getByRole('button', { name: 'Preview attendance change' });
  const apply = attendance.getByRole('button', { name: 'Apply this change' });
  const acknowledgement = attendance.getByRole('checkbox', { name: /Challonge bracket/ });
  await chooseOption(action, 'withdraw');
  await chooseOption(player, first!.playerId);
  await expect(acknowledgement).toHaveCount(0);
  await preview.click();
  await expect(acknowledgement).not.toBeChecked();
  await expect(apply).toBeDisabled();
  await acknowledgement.press('Space');
  await expect(apply).toBeEnabled();

  await preview.click();
  await expect(acknowledgement).not.toBeChecked();
  await expect(apply).toBeDisabled();
  await acknowledgement.press('Space');
  await chooseOption(action, 'no_show');
  await expect(acknowledgement).toHaveCount(0);
  await chooseOption(action, 'withdraw');
  await chooseOption(player, first!.playerId);
  await preview.click();
  await acknowledgement.press('Space');
  await chooseOption(player, second!.playerId);
  await expect(acknowledgement).toHaveCount(0);

  await preview.click();
  await expect(acknowledgement).not.toBeChecked();
  await expect(apply).toBeDisabled();
  await acknowledgement.press('Space');
  await apply.click();
  await expect(attendance.getByRole('status')).toContainText('Attendance updated');
  const after = await query<Snapshot & { attendanceAudit: { action: string; details: unknown }[] }>(
    page.request,
    'eventOps.overview',
    { planId },
  );
  expect(after.withdrawals).toEqual([expect.objectContaining({ playerId: second!.playerId })]);
  expect(after.attendanceAudit.filter(({ action }) => action === 'withdraw')).toEqual([
    expect.objectContaining({
      action: 'withdraw',
      details: expect.objectContaining({ playerId: second!.playerId, externalAcknowledged: true }),
    }),
  ]);
});
