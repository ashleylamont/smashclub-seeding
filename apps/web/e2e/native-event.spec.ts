import { chooseOption } from '../test-support/controls';
import { test, expect, type APIRequestContext } from '@playwright/test';

type Match = {
  id: string;
  label: string;
  revision: number;
  status: string;
  outcome: string | null;
  player1Id: string | null;
  player2Id: string | null;
  nativeBracketId: string | null;
  division: string;
  poolIndex: number | null;
};
type Snapshot = {
  matches: Match[];
  nativeBrackets: { complete: boolean; winnerId: string | null }[];
  plan: { status: string; bracketMode: string };
};
type Overview = {
  brackets: { slug: string; isComplete: boolean }[];
  divisions: {
    division: string;
    players: {
      place: number | null;
      wins: number;
      losses: number;
      poolWins: number;
      poolLosses: number;
      bracketWins: number;
      bracketLosses: number;
    }[];
  }[];
  warnings: string[];
};
async function query<T>(request: APIRequestContext, procedure: string, input?: object): Promise<T> {
  const response = await request.get(`/api/trpc/${procedure}`, {
    params: input ? { input: JSON.stringify(input) } : {},
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

test('native event progresses from pools through reviewed finals to public club results', async ({
  page,
}, testInfo) => {
  // Rehearse every pool/finals result plus publication and correction through Act.
  // Bound individual API calls above while allowing the complete night on CI.
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
  const name = 'Native finals reliability rehearsal';
  const { planId } = await mutate<{ planId: string }>(
    page.request,
    'admin.eventPlanner.createPlan',
    {
      name,
      bracketMode: 'native',
      eventDate: '2026-09-10T08:00:00.000Z',
      upperTargetSize: 7,
      rows: roster.entries.slice(0, 14).map((entry, index) => ({
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
    'eventOps.prepare',
  ])
    await mutate(page.request, procedure, {
      planId,
      ...(procedure === 'eventOps.softLockPools' ? { confirm: true } : {}),
    });
  await mutate(page.request, 'eventOps.settings', { planId, published: true, playerReports: true });
  let snapshot = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
  expect(snapshot.plan.bracketMode).toBe('native');
  await page.goto(`/live/${planId}`);
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await expect(page.locator('.event-pool')).toHaveCount(4);
  await expect(
    page.getByRole('link', { name: 'Player area · my matches & scores →' }),
  ).toBeVisible();
  type Pool = {
    poolIndex: number;
    members: { playerId: string }[];
    matchRevisions: { id: string; revision: number }[];
    placementRevision: string;
  };
  type Planner = { divisions: { division: string; pools: Pool[] }[] };
  await page.reload();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  const before = await query<Planner>(page.request, 'admin.eventPlanner.plan', { planId });
  const first = snapshot.matches[0]!;
  const firstOrder = before.divisions
    .find((division) => division.division === first.division)!
    .pools.find((pool) => pool.poolIndex === first.poolIndex)!
    .members.map((member) => member.playerId);
  const firstWins = firstOrder.indexOf(first.player1Id!) < firstOrder.indexOf(first.player2Id!);
  await page.goto(`/admin/event-operations?plan=${planId}`);
  await chooseOption(
    page
      .getByRole('tabpanel', { name: 'Run matches' })
      .getByRole('combobox', { name: 'View', exact: true }),
    'all',
  );
  const firstCard = page.locator('article.ops-match:visible').filter({ hasText: first.label });
  await firstCard.getByRole('button', { name: 'Finish match', exact: true }).click();
  await firstCard
    .locator('input[type="number"]')
    .nth(0)
    .fill(firstWins ? '2' : '0');
  await firstCard
    .locator('input[type="number"]')
    .nth(1)
    .fill(firstWins ? '0' : '2');
  await firstCard.getByRole('button', { name: 'Confirm result', exact: true }).click();
  await expect(page.locator('.ops-notice')).toContainText('Score recorded locally');
  snapshot = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
  expect(snapshot.matches.find((match) => match.id === first.id)?.status).toBe('complete');
  for (const match of snapshot.matches.filter((match) => match.status !== 'complete')) {
    const order = before.divisions
      .find((division) => division.division === match.division)!
      .pools.find((pool) => pool.poolIndex === match.poolIndex)!
      .members.map((member) => member.playerId);
    const firstWins = order.indexOf(match.player1Id!) < order.indexOf(match.player2Id!);
    const input = {
      matchId: match.id,
      expectedRevision: match.revision,
      requestId: `native-pool-${match.id}`,
      score1: firstWins ? 2 : 0,
      score2: firstWins ? 0 : 2,
      outcome: 'played',
    };
    const recorded = await mutate(page.request, 'eventOps.reportScore', input);
    expect(await mutate(page.request, 'eventOps.reportScore', input)).toEqual(recorded);
  }
  // A score correction invalidates old placement revisions; the final reviewed
  // order is based on the corrected persisted match, before finals are drawn.
  const currentPools = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
  const corrected = currentPools.matches.find((match) => match.id === first.id)!;
  await mutate(page.request, 'eventOps.reportScore', {
    matchId: corrected.id,
    expectedRevision: corrected.revision,
    requestId: 'native-correction',
    score1: firstWins ? 2 : 1,
    score2: firstWins ? 1 : 2,
    outcome: 'played',
  });
  const stale = await page.request.post('/api/trpc/eventOps.reportScore', {
    data: {
      matchId: first.id,
      expectedRevision: first.revision,
      requestId: 'stale-native-client',
      score1: 2,
      score2: 0,
      outcome: 'played',
    },
  });
  expect(stale.status()).toBe(409);
  const scored = await query<Planner>(page.request, 'admin.eventPlanner.plan', { planId });
  for (const division of scored.divisions)
    await mutate(page.request, 'admin.eventPlanner.savePoolPlacements', {
      planId,
      division: division.division,
      pools: division.pools.map((pool) => ({
        poolIndex: pool.poolIndex,
        playerIdsInOrder: pool.members.map((member) => member.playerId),
        expectedMatchRevisions: pool.matchRevisions,
        expectedPlacementRevision: pool.placementRevision,
      })),
    });
  await page.goto(`/live/${planId}`);
  await expect(page.getByRole('heading', { name: 'Confirmed pool standings' })).toBeVisible();
  await expect(page.locator('.event-pool-results .event-prize')).toHaveCount(4);
  await page.goto(`/admin/event-operations?plan=${planId}`);
  await chooseOption(
    page
      .getByRole('tabpanel', { name: 'Run matches' })
      .getByRole('combobox', { name: 'View', exact: true }),
    'all',
  );
  await expect(page.getByText('Challonge integration', { exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Standings / draw', exact: true }).click();
  const finals = page.locator('section.card').filter({
    has: page.getByRole('heading', { name: 'Championship and consolation', exact: true }),
  });
  await finals.getByRole('button', { name: 'Preview finals', exact: true }).click();
  await expect(
    finals.getByRole('heading', { name: 'upper championship · 4 entrants' }),
  ).toBeVisible();
  await expect(finals).toContainText('Bye');
  await finals.getByRole('button', { name: 'Create these finals' }).click();
  await expect(finals.getByRole('status')).toContainText('Finals are ready');
  for (let round = 0; round < 5; round++) {
    snapshot = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
    const ready = snapshot.matches.filter(
      (match) => match.nativeBracketId && match.status === 'ready',
    );
    if (!ready.length) break;
    for (const match of ready)
      await mutate(page.request, 'eventOps.reportScore', {
        matchId: match.id,
        expectedRevision: match.revision,
        requestId: crypto.randomUUID(),
        score1: 2,
        score2: 1,
        outcome: 'played',
      });
  }
  expect(snapshot.nativeBrackets).toHaveLength(4);
  expect(snapshot.nativeBrackets.every((bracket) => bracket.complete && bracket.winnerId)).toBe(
    true,
  );
  const played = snapshot.matches.filter((match) => match.outcome === 'played');
  const poolGames = played.filter((match) => !match.nativeBracketId).length;
  const finalsGames = played.length - poolGames;
  await finals.getByRole('button', { name: 'Finalize native results', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(finals.getByRole('status')).toContainText('Event finalized');
  await expect(page.getByText('Event closed · read only', { exact: true })).toBeVisible();
  expect(await mutate(page.request, 'eventOps.native.finalize', { planId })).toMatchObject({
    alreadyFinalized: true,
  });
  await page.reload();
  await expect(page.getByText('Event closed · read only', { exact: true })).toBeVisible();
  await page.goto(`/live/${planId}`);
  await expect(page.locator('.event-bracket')).toHaveCount(4);
  await expect(page.getByText('The next set is coming.', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Report your match score →' })).toHaveCount(0);
  await expect(page.locator('.event-bracket').first()).toContainText('Winner');
  await expect(page.locator('a[href*="challonge.com"]')).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath('native-completed-night.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('native-completed-night-mobile.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/admin/tournaments');
  const resultRow = page.getByRole('row').filter({ hasText: `${name} Upper Main` });
  await expect(resultRow).toContainText('Saved in Nemesis');
  await resultRow.getByRole('link', { name: 'Nemesis event results →' }).click();
  await expect(page).toHaveURL(/\/events\/nemesis_/);
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  const slug = decodeURIComponent(new URL(page.url()).pathname.split('/').at(-1)!);
  const overview = await query<Overview>(page.request, 'public.eventOverview', { slug });
  expect(overview.warnings).toEqual([]);
  expect(overview.brackets).toHaveLength(4);
  expect(overview.brackets.every((bracket) => bracket.isComplete)).toBe(true);
  expect(
    overview.divisions.map((division) => [division.division, division.players.length]),
  ).toEqual([
    ['upper', 7],
    ['lower', 7],
  ]);
  const results = overview.divisions.flatMap((division) => division.players);
  expect(results.every((player) => player.place !== null)).toBe(true);
  expect(results.reduce((sum, player) => sum + player.wins, 0)).toBe(played.length);
  expect(results.reduce((sum, player) => sum + player.losses, 0)).toBe(played.length);
  expect(results.reduce((sum, player) => sum + player.poolWins, 0)).toBe(poolGames);
  expect(results.reduce((sum, player) => sum + player.poolLosses, 0)).toBe(poolGames);
  expect(results.reduce((sum, player) => sum + player.bracketWins, 0)).toBe(finalsGames);
  expect(results.reduce((sum, player) => sum + player.bracketLosses, 0)).toBe(finalsGames);
  const divisionStandings = page.locator('.section > .table-scroll .event-standings');
  await expect(divisionStandings).toHaveCount(2);
  await expect(divisionStandings.locator('tbody tr')).toHaveCount(14);
  await page.getByRole('link', { name: 'Recap →', exact: true }).click();
  await expect(page).toHaveURL(/\/recaps\/nemesis_/);
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(page.locator('.recap-podiums .podium')).toHaveCount(4);
  await expect(page.locator('.recap-bracket-list li')).toHaveCount(4);
  await expect(page.locator('.recap-progress-chip')).toHaveCount(0);
  await page.goto(`/admin/event-operations?plan=${planId}&view=draw`);
  const correction = page
    .locator('section.card')
    .filter({ has: page.getByRole('heading', { name: 'Published results and corrections' }) });
  await expect(correction).toContainText('Result revision 1 published.');
  const correctedMatch = played.find((m) => m.nativeBracketId)!;
  await chooseOption(
    correction.getByRole('combobox', { name: 'Completed match' }),
    correctedMatch.id,
  );
  await correction.locator('input[type="number"]').nth(0).fill('3');
  await correction.locator('input[type="number"]').nth(1).fill('1');
  await correction.getByLabel('Ruling reason').fill('The TO reviewed the final game count.');
  await correction.getByRole('button', { name: 'Publish reviewed correction' }).click();
  await expect(correction).toContainText('Result revision 2 published.');
  const replaced = await query<Overview>(page.request, 'public.eventOverview', { slug });
  expect(replaced.brackets).toHaveLength(4);
  expect(replaced.divisions.flatMap((d) => d.players).reduce((sum, p) => sum + p.wins, 0)).toBe(
    played.length,
  );
  expect(replaced.warnings).toEqual([]);
  await page.goto(`/recaps/${slug}`);
  await expect(page.locator('.recap-podiums .podium')).toHaveCount(4);
});
