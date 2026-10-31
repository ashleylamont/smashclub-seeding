import { expect, test, type APIRequestContext } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import type { PoolFlowMatch } from '../src/lib/poolFlow';
import { bracketBackupSheets } from '../src/lib/bracketBackupSheets';
import { chooseOption } from '../test-support/controls';

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

test('an uneven native draw keeps meaningful names across player, TO, feeders, paper, history and publication', async ({
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
    .slice(0, 5);
  const name = 'Meaningful match names rehearsal';
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
  const snapshot = (procedure = 'eventOps.snapshot') =>
    rpc<Omit<Parameters<typeof bracketBackupSheets>[0], 'matches'> & { matches: PoolFlowMatch[] }>(
      page.request,
      procedure,
      { planId },
    );
  const before = (await snapshot()).matches;
  expect(before.map((m) => m.label).sort()).toEqual(
    [
      'Final',
      'Quarter-final 1',
      'Quarter-final 2',
      'Quarter-final 3',
      'Quarter-final 4',
      'Semi-final 1',
      'Semi-final 2',
    ].sort(),
  );
  expect(before.some((m) => m.outcome === 'bye')).toBe(true);
  for (const procedure of ['eventOps.live.snapshot', 'eventOps.overview'])
    expect((await snapshot(procedure)).matches.map((m) => [m.id, m.label])).toEqual(
      before.map((m) => [m.id, m.label]),
    );
  const first = before.find((m) => m.status === 'ready' && m.label.startsWith('Quarter-final'))!;
  expect(first).toBeTruthy();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/play/${planId}?player=${first.player1Id}`);
  await expect(page.getByRole('complementary', { name: 'Your progress' })).toContainText(
    first.label,
  );
  await expect(page.locator('.event-brackets')).toContainText('Winner of Quarter-final');
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
    path: testInfo.outputPath('native-names-player-phone.png'),
    fullPage: true,
  });
  await page.goto(`/operate/${planId}`);
  const run = page.getByRole('tabpanel', { name: 'Run matches' });
  await chooseOption(run.getByRole('combobox', { name: 'View', exact: true }), 'all');
  await expect(run.locator('article.ops-match').filter({ hasText: first.label })).toBeVisible();
  // The current knockout desk does not expose the print launcher. Verify the
  // existing print-data consumer against the real API rather than inventing it.
  const paper = bracketBackupSheets(await snapshot())[0]!;
  expect(paper.matches.map((m) => m.label).sort()).toEqual(before.map((m) => m.label).sort());
  expect(
    paper.matches.some((m) => [m.player1, m.player2].includes('Winner of Quarter-final 2')),
  ).toBe(true);
  await rpc(
    page.request,
    'eventOps.reportScore',
    {
      matchId: first.id,
      expectedRevision: first.revision,
      requestId: crypto.randomUUID(),
      score1: 2,
      score2: 0,
      outcome: 'played',
    },
    true,
  );
  const history = await rpc<{ entries: { title: string; summary: string }[] }>(
    page.request,
    'eventOps.live.history',
    { planId },
  );
  expect(
    history.entries.some((e) => e.title === 'Result recorded' && e.summary.includes(first.label)),
  ).toBe(true);
  for (let i = 0; i < 6; i++) {
    const ready = (await snapshot()).matches.filter((m) => m.status === 'ready');
    if (!ready.length) break;
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
  const after = (await snapshot()).matches;
  expect(after.every((m) => m.status === 'complete')).toBe(true);
  expect(after.map((m) => [m.id, m.label])).toEqual(before.map((m) => [m.id, m.label]));
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
  const published = await rpc<{ sets: { identifier: string }[] }>(
    page.request,
    'public.tournament',
    { slug: event.slug },
  );
  expect(published.sets.map((m) => m.identifier).sort()).toEqual(before.map((m) => m.label).sort());
});
