import { expect, test, type APIRequestContext } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import type { PoolFlowMatch } from '../src/lib/poolFlow';

async function rpc<T>(
  request: APIRequestContext,
  procedure: string,
  input: object,
  mutation = false,
) {
  const response = mutation
    ? await request.post(`/api/trpc/${procedure}`, { data: input })
    : await request.get(`/api/trpc/${procedure}`, { params: { input: JSON.stringify(input) } });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result.data as T;
}

test('personal progress follows a real loss, safe correction and confirmed bracket win', async ({
  page,
}, testInfo) => {
  await page.request.post('/api/auth/sign-in/email', {
    data: { email: 'admin@smashclub.dev', password: 'devpassword123' },
  });
  const players = (
    await rpc<{ id: string; canonicalName: string; status: string }[]>(
      page.request,
      'admin.players',
      {},
    )
  )
    .filter((player) => player.status === 'active')
    .slice(0, 4);
  const { planId } = await rpc<{ planId: string }>(
    page.request,
    'admin.eventPlanner.createPlan',
    {
      name: 'Personal progression rehearsal',
      eventDate: '2026-10-31T18:30:00Z',
      structure: 'single_elimination',
      bracketMode: 'native',
      rows: players.map((player, i) => ({
        lineNumber: i + 1,
        rawInput: player.canonicalName,
        cleanedName: player.canonicalName,
        playerId: player.id,
        companyId: null,
        resolutionMethod: 'manual',
      })),
    },
    true,
  );
  for (const procedure of [
    'admin.eventPlanner.freezeRoster',
    'admin.eventPlanner.generatePools',
    'eventOps.softLockPools',
    'eventOps.prepare',
  ])
    await rpc(
      page.request,
      procedure,
      { planId, ...(procedure === 'eventOps.softLockPools' ? { confirm: true } : {}) },
      true,
    );
  await rpc(
    page.request,
    'eventOps.settings',
    { planId, published: true, playerReports: true },
    true,
  );
  type Snapshot = { matches: PoolFlowMatch[]; plan: { status: string } };
  const snapshot = () => rpc<Snapshot>(page.request, 'eventOps.snapshot', { planId });
  const report = (match: PoolFlowMatch, score1: number, score2: number) =>
    rpc(
      page.request,
      'eventOps.reportScore',
      {
        matchId: match.id,
        expectedRevision: match.revision,
        requestId: crypto.randomUUID(),
        score1,
        score2,
        outcome: 'played',
      },
      true,
    );
  let state = await snapshot();
  const semi = state.matches.find(
    (match) => match.status === 'ready' && match.player1Id && match.player2Id,
  )!;
  expect(semi).toBeTruthy();
  const playerId = semi.player1Id!;
  const visit = () => page.goto(`/play/${planId}?player=${playerId}`);
  const progress = page.getByRole('complementary', { name: 'Your progress' });

  await report(semi, 0, 2);
  await visit();
  await expect(progress).toHaveAttribute('data-journey-state', 'bracket_finished');
  await expect(progress).toContainText('while the event continues');
  await expect(progress.getByRole('button', { name: 'Find next match' })).toHaveCount(0);
  await expect(page.locator('#event-results')).toContainText(semi.label);
  expect((await snapshot()).plan.status).not.toBe('complete');

  // Correcting the unadvanced result should reopen this player's actual winner path.
  state = await snapshot();
  await report(
    state.matches.find((match) => match.id === semi.id)!,
    2,
    0,
  );
  await visit();
  await expect(progress).toHaveAttribute('data-journey-state', 'awaiting_opponent');
  await expect(progress).toContainText('Waiting for a confirmed pairing');
  state = await snapshot();
  const otherSemi = state.matches.find(
    (match) =>
      match.status === 'ready' && match.id !== semi.id && match.player1Id && match.player2Id,
  )!;
  expect(otherSemi).toBeTruthy();
  await report(otherSemi, 2, 0);
  state = await snapshot();
  const final = state.matches.find(
    (match) =>
      match.status === 'ready' && (match.player1Id === playerId || match.player2Id === playerId),
  )!;
  expect(final).toBeTruthy();
  await visit();
  await expect(progress).toHaveAttribute('data-journey-state', 'active');
  await expect(progress).toContainText(final.label);
  await report(final, final.player1Id === playerId ? 2 : 0, final.player2Id === playerId ? 2 : 0);
  await visit();
  await expect(progress).toHaveAttribute('data-journey-state', 'winner');
  await expect(progress).toContainText('You won the championship bracket');
  expect((await snapshot()).plan.status).not.toBe('complete');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    (
      await new AxeBuilder({ page })
        .include('.player-event-hub')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('real-player-winner-phone.png'),
    fullPage: true,
  });
});
