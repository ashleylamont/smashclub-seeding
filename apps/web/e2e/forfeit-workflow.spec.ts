import { expect, test, type APIRequestContext } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { chooseOption } from '../test-support/controls';
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

test('a phone TO records a forfeit without games, advances its winner and publishes it outside rating inputs', async ({
  page,
}, testInfo) => {
  const login = await page.request.post('/api/auth/sign-in/email', {
    data: { email: 'admin@smashclub.dev', password: 'devpassword123' },
  });
  expect(login.ok()).toBe(true);
  const players = (
    await rpc<{ id: string; canonicalName: string; status: string }[]>(
      page.request,
      'admin.players',
      {},
    )
  )
    .filter((p) => p.status === 'active')
    .slice(0, 4);
  const name = 'Reviewed forfeit rehearsal';
  const { planId } = await rpc<{ planId: string }>(
    page.request,
    'admin.eventPlanner.createPlan',
    {
      name,
      eventDate: '2026-10-31T18:30:00Z',
      structure: 'single_elimination',
      bracketMode: 'native',
      rows: players.map((p, i) => ({
        lineNumber: i + 1,
        rawInput: p.canonicalName,
        cleanedName: p.canonicalName,
        playerId: p.id,
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
  const snapshot = () =>
    rpc<{ matches: PoolFlowMatch[] }>(page.request, 'eventOps.snapshot', { planId });
  const first = (await snapshot()).matches.find((m) => m.status === 'ready')!;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/operate/${planId}`);
  const run = page.getByRole('tabpanel', { name: 'Run matches' });
  await chooseOption(run.getByRole('combobox', { name: 'View', exact: true }), 'all');
  const card = run.locator('article.ops-match:visible').filter({ hasText: first.label });
  await card.getByRole('button', { name: 'Record forfeit', exact: true }).click();
  await expect(card.getByRole('spinbutton')).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Confirm forfeit', exact: true })).toBeDisabled();
  await chooseOption(card.getByRole('combobox', { name: 'Winner', exact: true }), first.player2Id!);
  await card.getByRole('button', { name: 'Confirm forfeit', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('no played games or rating input');
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Forfeit recorded locally');
  let state = await snapshot();
  expect(state.matches.find((m) => m.id === first.id)).toMatchObject({
    status: 'complete',
    outcome: 'forfeit',
    winnerId: first.player2Id,
    score1: null,
    score2: null,
    revision: first.revision + 1,
  });
  await page.goto(`/play/${planId}?player=${first.player2Id}`);
  const recorded = page.locator('article.ops-match').filter({ hasText: first.label });
  await expect(recorded).toContainText('forfeit');
  await expect(recorded.getByRole('spinbutton')).toHaveCount(0);
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
    path: testInfo.outputPath('real-forfeit-player-phone.png'),
    fullPage: true,
  });
  for (let i = 0; i < 3; i++) {
    state = await snapshot();
    const ready = state.matches.filter((m) => m.status === 'ready');
    if (!ready.length) break;
    if (i === 1) {
      const next = ready.find(
        (m) => m.parent1MatchId === first.id || m.parent2MatchId === first.id,
      )!;
      expect(next).toBeTruthy();
      expect([next.player1Id, next.player2Id]).toContain(first.player2Id);
    }
    for (const match of ready)
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
  }
  expect((await snapshot()).matches.every((m) => m.status === 'complete')).toBe(true);
  await rpc(
    page.request,
    'eventOps.live.command',
    { planId, requestId: crypto.randomUUID(), command: { kind: 'finalize' } },
    true,
  );
  const events = await rpc<{ slug: string; name: string }[]>(
    page.request,
    'public.tournaments',
    {},
  );
  const event = events.find((e) => e.name.startsWith(name))!;
  expect(event).toBeTruthy();
  const published = await rpc<{
    sets: {
      identifier: string;
      scoresCsv: string | null;
      excludedFromRatings: boolean;
      winner: number;
    }[];
  }>(page.request, 'public.tournament', { slug: event.slug });
  expect(published.sets.find((m) => m.identifier === first.label)).toMatchObject({
    scoresCsv: null,
    excludedFromRatings: true,
    winner: 2,
  });
  expect(published.sets.filter((m) => !m.excludedFromRatings)).toHaveLength(2);
});
