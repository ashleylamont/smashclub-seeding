import { expect, test, type APIRequestContext } from '@playwright/test';
import { chooseOption } from '../test-support/controls';

async function query<T>(request: APIRequestContext, name: string, input?: object): Promise<T> {
  const response = await request.get(`/api/trpc/${name}`, {
    params: input ? { input: JSON.stringify(input) } : {},
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result.data as T;
}
async function mutate<T>(request: APIRequestContext, name: string, data: object): Promise<T> {
  const response = await request.post(`/api/trpc/${name}`, { data });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result.data as T;
}
type Match = {
  id: string;
  revision: number;
  status: string;
  bracketLane?: string;
  outcome: string | null;
};
type Snapshot = { matches: Match[]; poolSchedules: { division: string; poolIndex: number }[] };
async function scoreReady(request: APIRequestContext, planId: string, reset: boolean) {
  for (let i = 0; i < 100; i++) {
    const ready = (await query<Snapshot>(request, 'eventOps.snapshot', { planId })).matches.filter(
      (m) => m.status === 'ready',
    );
    if (!ready.length) return;
    for (const m of ready) {
      const upset = reset && m.bracketLane === 'final';
      await mutate(request, 'eventOps.reportScore', {
        matchId: m.id,
        expectedRevision: m.revision,
        requestId: crypto.randomUUID(),
        score1: upset ? 0 : 2,
        score2: upset ? 2 : 0,
        outcome: 'played',
      });
    }
  }
  throw new Error('Tournament did not finish.');
}

for (const [structure, played] of [
  ['single_elimination', 4],
  ['double_elimination', 9],
  ['round_robin_finals', 22],
] as const)
  test(`configures ${structure}, completes its draw and publishes public standings`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.request.post('/api/auth/sign-in/email', {
      data: { email: 'admin@smashclub.dev', password: 'devpassword123' },
    });
    const entrants = (
      await query<{ id: string; canonicalName: string; status: string }[]>(
        page.request,
        'admin.players',
      )
    )
      .filter((p) => p.status === 'active')
      .slice(0, 5);
    const name = `Browser ${structure}`;
    const { planId } = await mutate<{ planId: string }>(
      page.request,
      'admin.eventPlanner.createPlan',
      {
        name,
        eventDate: '2026-10-22T18:30:00Z',
        structure: 'round_robin',
        rows: entrants.map((p, i) => ({
          lineNumber: i + 1,
          rawInput: p.canonicalName,
          cleanedName: p.canonicalName,
          playerId: p.id,
          companyId: null,
          resolutionMethod: 'manual',
        })),
      },
    );
    await page.goto(`/admin/event-planner?plan=${planId}`);
    await chooseOption(
      page.getByRole('combobox', { name: 'Tournament structure', exact: true }),
      structure,
    );
    await expect
      .poll(
        async () =>
          (
            await query<{ plan: { structure: string } }>(page.request, 'admin.eventPlanner.plan', {
              planId,
            })
          ).plan.structure,
      )
      .toBe(structure);
    if (structure === 'round_robin_finals') {
      await page.getByRole('spinbutton', { name: 'Playoff entrants', exact: true }).fill('3');
      await expect
        .poll(
          async () =>
            (
              await query<{ plan: { structureOptions: { playoffSize: number } } }>(
                page.request,
                'admin.eventPlanner.plan',
                { planId },
              )
            ).plan.structureOptions.playoffSize,
        )
        .toBe(3);
      await page
        .getByRole('spinbutton', { name: 'Round-robin meetings per pairing', exact: true })
        .fill('2');
      await expect
        .poll(
          async () =>
            (
              await query<{
                plan: { structureOptions: { roundRobinMeetings: number; playoffSize: number } };
              }>(page.request, 'admin.eventPlanner.plan', { planId })
            ).plan.structureOptions,
        )
        .toEqual({ roundRobinMeetings: 2, playoffSize: 3 });
    }
    await page
      .getByRole('button', { name: 'Freeze roster & split divisions', exact: true })
      .click();
    const generated = page.waitForResponse(
      (response) =>
        response.url().includes('admin.eventPlanner.generatePools') &&
        response.request().method() === 'POST',
    );
    await page
      .getByRole('button', {
        name: structure === 'round_robin_finals' ? 'Generate pools' : 'Generate draw',
        exact: true,
      })
      .click();
    expect((await generated).ok()).toBe(true);
    await mutate(page.request, 'eventOps.softLockPools', { planId, confirm: true });
    await mutate(page.request, 'eventOps.settings', {
      planId,
      published: true,
      playerReports: true,
    });
    await scoreReady(page.request, planId, structure === 'double_elimination');
    if (structure === 'round_robin_finals') {
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
      for (const division of view.divisions)
        await mutate(page.request, 'admin.eventPlanner.savePoolPlacements', {
          planId,
          division: division.division,
          pools: division.pools.map((p) => ({
            poolIndex: p.poolIndex,
            playerIdsInOrder: p.members.map((m) => m.playerId),
            expectedMatchRevisions: p.matchRevisions,
            expectedPlacementRevision: p.placementRevision,
          })),
        });
      const preview = await query<{ revisionToken: string }>(
        page.request,
        'eventOps.native.preview',
        { planId },
      );
      await mutate(page.request, 'eventOps.native.generate', {
        planId,
        revisionToken: preview.revisionToken,
      });
      await scoreReady(page.request, planId, false);
    }
    const final = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
    expect(final.matches.filter((m) => m.outcome === 'played')).toHaveLength(played);
    await page.goto(`/admin/event-operations?plan=${planId}&view=draw`);
    await expect(
      page.getByRole('heading', {
        name:
          structure === 'round_robin_finals' ? 'Championship and consolation' : 'Knockout results',
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Finalize native results', exact: true }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Confirm', exact: true })
      .click();
    await expect(page.getByText('Result revision 1 published.', { exact: false })).toBeVisible();
    const events = await query<{ slug: string; name: string }[]>(
      page.request,
      'public.tournaments',
    );
    const result = events.find((e) => e.name.startsWith(name))!;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/events/${result.slug}`);
    await expect(page.locator('.section > .table-scroll .event-standings tbody tr')).toHaveCount(5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
