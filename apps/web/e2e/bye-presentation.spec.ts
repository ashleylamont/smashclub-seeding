import { expect, test, type APIRequestContext } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import type { PoolFlowMatch } from '../src/lib/poolFlow';

async function rpc<T>(
  request: APIRequestContext,
  procedure: string,
  input: object,
  mutation = false,
): Promise<T> {
  const response = mutation
    ? await request.post(`/api/trpc/${procedure}`, { data: input })
    : await request.get(`/api/trpc/${procedure}`, { params: { input: JSON.stringify(input) } });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result.data as T;
}

test('real native first-round and propagated byes show automatic advancement and pending opponents honestly', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
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
    .slice(0, 5);
  const { planId } = await rpc<{ planId: string }>(
    page.request,
    'admin.eventPlanner.createPlan',
    {
      name: 'Native bye presentation rehearsal',
      eventDate: '2026-10-22T18:30:00Z',
      structure: 'double_elimination',
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
  type Snapshot = { matches: PoolFlowMatch[] };
  let snapshot = await rpc<Snapshot>(page.request, 'eventOps.snapshot', { planId });
  const firstBye = snapshot.matches.find(
    (match) => match.outcome === 'bye' && !match.parent1MatchId && !match.parent2MatchId,
  )!;
  expect(firstBye).toBeTruthy();
  expect(firstBye.score1).toBeNull();
  expect(firstBye.score2).toBeNull();
  await page.goto(`/play/${planId}?player=${firstBye.winnerId}`);
  const firstCard = page.locator('article.ops-match').filter({ hasText: firstBye.label });
  await expect(firstCard).toContainText('advanced automatically');
  await expect(firstCard.getByRole('spinbutton')).toHaveCount(0);
  await expect(firstCard.getByRole('button')).toHaveCount(0);
  for (
    let i = 0;
    i < 6 &&
    !snapshot.matches.some(
      (match) => match.outcome === 'bye' && (match.parent1MatchId || match.parent2MatchId),
    );
    i++
  ) {
    for (const match of snapshot.matches.filter((match) => match.status === 'ready'))
      await rpc(
        page.request,
        'eventOps.reportScore',
        {
          matchId: match.id,
          expectedRevision: match.revision,
          requestId: crypto.randomUUID(),
          score1: 2,
          score2: 0,
          outcome: 'played',
        },
        true,
      );
    snapshot = await rpc<Snapshot>(page.request, 'eventOps.snapshot', { planId });
  }
  const next = snapshot.matches.find(
    (match) =>
      match.status !== 'complete' &&
      (match.player1Id === firstBye.winnerId || match.player2Id === firstBye.winnerId),
  );
  expect(next).toBeTruthy();
  await page.goto(`/play/${planId}?player=${firstBye.winnerId}`);
  await expect(page.getByRole('complementary', { name: 'Your progress' })).toContainText(
    next!.label,
  );
  const propagated = snapshot.matches.find(
    (match) => match.outcome === 'bye' && (match.parent1MatchId || match.parent2MatchId),
  )!;
  expect(propagated).toBeTruthy();
  expect(propagated.score1).toBeNull();
  expect(propagated.score2).toBeNull();
  await page.goto(`/play/${planId}?player=${propagated.winnerId}`);
  const card = page.locator('article.ops-match').filter({ hasText: propagated.label });
  await expect(card).toContainText('advanced automatically');
  await expect(card.getByRole('spinbutton')).toHaveCount(0);
  await expect(card.getByRole('button')).toHaveCount(0);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      (
        await new AxeBuilder({ page })
          .include('.player-event-hub')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath(`native-propagated-bye-${width}.png`),
      fullPage: true,
    });
  }
  await testInfo.attach('real-native-byes.json', {
    body: JSON.stringify({ firstBye, propagated, next }, null, 2),
    contentType: 'application/json',
  });
});
