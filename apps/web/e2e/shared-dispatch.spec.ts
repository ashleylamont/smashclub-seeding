import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { chooseOption } from '../test-support/controls';

type Match = {
  id: string;
  label: string;
  player1Id: string;
  player2Id: string;
  player1Name: string;
  player2Name: string;
  status: string;
  started: boolean;
  called: boolean;
  callLocation: string | null;
  stationId: string | null;
  revision: number;
};
type Overview = {
  matches: Match[];
  stations: { id: string; name: string }[];
  settings: { resourceRevision: number };
  sharedDispatch: { active: number; capacity: number } | null;
};
async function signIn(request: APIRequestContext) {
  const response = await request.post('/api/auth/sign-in/email', {
    data: { email: 'admin@smashclub.dev', password: 'devpassword123' },
  });
  expect(response.ok(), await response.text()).toBe(true);
}
async function query<T>(request: APIRequestContext, procedure: string, input = {}): Promise<T> {
  const response = await request.get(`/api/trpc/${procedure}`, {
    params: { input: JSON.stringify(input) },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result.data;
}
async function mutate<T>(request: APIRequestContext, procedure: string, data: object): Promise<T> {
  const response = await request.post(`/api/trpc/${procedure}`, { data });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result.data;
}
async function night(page: Page, name: string, named = true) {
  await signIn(page.request);
  const plans = await query<{ id: string; name: string }[]>(
    page.request,
    'admin.eventPlanner.plans',
  );
  const source = plans.find((p) => p.name === 'Nemesis · Rehearsal Night')!;
  const roster = await query<{ entries: { playerId: string; playerName: string }[] }>(
    page.request,
    'admin.eventPlanner.plan',
    { planId: source.id },
  );
  const { planId } = await mutate<{ planId: string }>(
    page.request,
    'admin.eventPlanner.createPlan',
    {
      name,
      bracketMode: 'native',
      eventDate: '2026-10-31T09:00:00Z',
      upperTargetSize: 4,
      rows: roster.entries.slice(0, 8).map((e, index) => ({
        lineNumber: index + 1,
        rawInput: e.playerName,
        cleanedName: e.playerName,
        playerId: e.playerId,
        companyId: null,
        resolutionMethod: 'manual',
        divisionPreference: 'auto',
      })),
    },
  );
  for (const procedure of [
    'admin.eventPlanner.freezeRoster',
    'admin.eventPlanner.generatePools',
    'eventOps.prepare',
  ])
    await mutate(page.request, procedure, { planId });
  await mutate(page.request, 'eventOps.softLockPools', { planId, confirm: true });
  await mutate(page.request, 'eventOps.settings', { planId, published: true, playerReports: true });
  if (named) await mutate(page.request, 'eventOps.saveStation', { planId, name: 'Main stage' });
  await page.goto(`/operate/${planId}`);
  const desk = page.getByRole('region', { name: 'TO match queue' });
  await expect(
    desk.getByRole('heading', { name: 'Use a flexible shared match queue' }),
  ).toBeVisible();
  if (named) await desk.getByRole('checkbox', { name: 'Main stage', exact: true }).check();
  // Selecting a separately reserved station must not double-count it in the
  // untouched default ordinary count.
  await expect(desk.getByRole('spinbutton', { name: 'Ordinary concurrent matches' })).toHaveValue(
    '0',
  );
  await desk.getByRole('spinbutton', { name: 'Ordinary concurrent matches' }).fill('1');
  await desk.getByRole('button', { name: 'Enable shared match queue' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(desk.getByRole('heading', { name: 'Ordinary setups', exact: true })).toBeVisible();
  return { planId, desk };
}

test('shared queue: manual order, independent Main stage, capacity reduction and public calls', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const { planId, desk } = await night(page, 'Shared dispatch desktop');
  const ids = await desk
    .locator('.dispatch-list [data-match-id]')
    .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-match-id')!));
  const second = desk.locator(`[data-match-id="${ids[1]}"]`);
  await second.getByRole('button', { name: 'Move up', exact: true }).click();
  await expect(desk.locator('.dispatch-list [data-match-id]').first()).toHaveAttribute(
    'data-match-id',
    ids[1]!,
  );
  await second.getByRole('textbox', { name: 'Call location (optional)' }).fill('Window setup');
  await second.getByRole('button', { name: 'Call ordinary match' }).click();
  await expect(desk.getByText('1 / 1 in use', { exact: true })).toBeVisible();
  const overview = await query<Overview>(page.request, 'eventOps.overview', { planId });
  const called = overview.matches.find((m) => m.id === ids[1])!;
  expect(called).toMatchObject({
    status: 'playing',
    started: false,
    called: true,
    callLocation: 'Window setup',
    stationId: null,
  });
  const separate = overview.matches.find(
    (m) =>
      m.status === 'ready' &&
      ![called.player1Id, called.player2Id].includes(m.player1Id) &&
      ![called.player1Id, called.player2Id].includes(m.player2Id),
  )!;
  const stageRow = desk.locator(`[data-match-id="${separate.id}"]`);
  await chooseOption(
    stageRow.getByRole('combobox', { name: 'Named station', exact: true }),
    overview.stations[0]!.id,
  );
  await stageRow.getByRole('button', { name: 'Start named station' }).click();
  await expect(desk.getByText('1 / 1 in use', { exact: true })).toBeVisible();
  await expect
    .poll(
      async () =>
        (await query<Overview>(page.request, 'eventOps.overview', { planId })).matches.find(
          (m) => m.id === separate.id,
        )!.started,
    )
    .toBe(true);
  // Clean settings follow routine resource changes; they do not become a
  // permanently stale form after each call.
  await desk.getByRole('button', { name: 'Capacity and named stations', exact: true }).click();
  await expect(desk.getByRole('button', { name: 'Save capacity' })).toBeEnabled();
  await desk.getByRole('spinbutton', { name: 'Ordinary concurrent matches' }).fill('0');
  await desk.getByRole('button', { name: 'Save capacity' }).click();
  await expect(desk.getByText(/above the new cap/)).toBeVisible();
  expect(
    (await query<Overview>(page.request, 'eventOps.overview', { planId })).matches.filter(
      (m) => m.status === 'playing',
    ),
  ).toHaveLength(2);
  const publicContext = await browser.newContext({ baseURL });
  try {
    const board = await publicContext.newPage();
    await board.goto(`/play/${planId}`);
    const calls = board.getByRole('region', { name: 'Match calls' });
    await expect(calls.getByText('Called · Window setup', { exact: true })).toBeVisible();
    const personal = board.locator('article.ops-match').filter({ hasText: called.label });
    await expect(personal.locator('.ops-match-meta')).toContainText('Called');
    await expect(personal.locator('.ops-match-meta')).toContainText('Window setup');
    await expect(personal.locator('.ops-match-meta')).not.toContainText('Playing now');

    await expect(board.getByRole('button', { name: 'Move up', exact: true })).toHaveCount(0);
    await expect(board.getByRole('button', { name: /Snooze/ })).toHaveCount(0);
    const response = await publicContext.request.get('/api/trpc/eventOps.live.dispatchDesk', {
      params: { input: JSON.stringify({ planId }) },
    });
    expect(response.status()).toBe(401);
  } finally {
    await publicContext.close();
  }
  const active = desk.locator(`[data-match-id="${called.id}"]`);
  await active.getByRole('button', { name: 'Return untaken call' }).click();
  await expect(desk.getByText('0 / 0 in use', { exact: true })).toBeVisible();
  expect(
    (await query<Overview>(page.request, 'eventOps.overview', { planId })).matches.find(
      (m) => m.id === called.id,
    )!.started,
  ).toBe(false);
  await desk.getByRole('spinbutton', { name: 'Ordinary concurrent matches' }).fill('1');
  await desk.getByRole('button', { name: 'Save capacity' }).click();
  await desk.getByRole('button', { name: 'Capacity and named stations', exact: true }).click();
  await expect(desk.locator('.dispatch-list [data-match-id]').first()).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: testInfo.outputPath('shared-dispatch-desktop.png'),
    fullPage: true,
  });
  await testInfo.attach('shared-dispatch-desktop', {
    path: testInfo.outputPath('shared-dispatch-desktop.png'),
    contentType: 'image/png',
  });
});

test('shared queue on a phone: snooze/return, focused scoring, and accessible controls', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { planId, desk } = await night(page, 'Shared dispatch phone');
  const initial = await query<Overview>(page.request, 'eventOps.overview', { planId });
  const target = initial.matches.find((m) => m.status === 'ready')!;
  await desk.getByRole('button', { name: 'Player availability and pool holds' }).click();
  await desk.getByRole('button', { name: `Snooze ${target.player1Name}`, exact: true }).click();
  await expect(desk.locator(`.dispatch-list [data-match-id="${target.id}"]`)).toHaveCount(0);
  await chooseOption(desk.getByRole('combobox', { name: 'Queue view', exact: true }), 'waiting');
  await expect(
    desk
      .locator(`[data-match-id="${target.id}"]`)
      .getByText('An entrant or team member is unavailable.', { exact: true }),
  ).toBeVisible();
  await desk.getByRole('button', { name: `Return ${target.player1Name}`, exact: true }).click();
  await chooseOption(desk.getByRole('combobox', { name: 'Queue view', exact: true }), 'ready');
  const row = desk.locator(`[data-match-id="${target.id}"]`);
  await row.getByRole('button', { name: 'Call ordinary match' }).click();
  await desk
    .locator(`[data-match-id="${target.id}"]`)
    .getByRole('button', { name: 'Score / details' })
    .click();
  const card = page.locator('article.ops-match:visible').filter({ hasText: target.label });
  await expect(card).toBeVisible();
  const tabBottom = await page
    .locator('.ops-workspace-nav')
    .evaluate((element) => element.getBoundingClientRect().bottom);
  await expect(card).toBeInViewport();
  await expect.poll(async () => (await card.boundingBox())!.y).toBeGreaterThanOrEqual(tabBottom);
  await card.getByRole('button', { name: 'Finish match', exact: true }).click();
  await card.getByRole('spinbutton').nth(0).fill('2');
  await card.getByRole('spinbutton').nth(1).fill('0');
  await card.getByRole('button', { name: 'Confirm result', exact: true }).click();
  await expect(desk.getByText('0 / 1 in use', { exact: true })).toBeVisible();
  expect(
    (await query<Overview>(page.request, 'eventOps.overview', { planId })).matches.find(
      (m) => m.id === target.id,
    )!.status,
  ).toBe('complete');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const accessibility = await new AxeBuilder({ page })
    .include('.dispatch-desk')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('shared-dispatch-phone.png') });
  await page.screenshot({
    path: testInfo.outputPath('shared-dispatch-phone-full.png'),
    fullPage: true,
  });
  await desk
    .locator('.dispatch-list article')
    .first()
    .evaluate((element) => {
      const nav = document.querySelector('.app-nav')!.getBoundingClientRect().height;
      const tabs = document.querySelector('.ops-workspace-nav')!.getBoundingClientRect().height;
      window.scrollTo({
        top: window.scrollY + element.getBoundingClientRect().top - nav - tabs - 16,
        behavior: 'instant',
      });
    });
  await page.screenshot({ path: testInfo.outputPath('shared-dispatch-phone-ready.png') });

  await testInfo.attach('shared-dispatch-phone', {
    path: testInfo.outputPath('shared-dispatch-phone.png'),
    contentType: 'image/png',
  });
});

test('ordinary-only setup does not require named stations', async ({ page }) => {
  const { desk } = await night(page, 'Ordinary-only shared dispatch', false);
  // Other workspace tabs retain hidden no-station choices; the attention
  // panel must not flag a missing setup when ordinary capacity exists.
  const attention = page.locator('.ops-attention');
  await expect(attention.getByText('No stations configured', { exact: true })).toHaveCount(0);
  await expect(attention.getByText('No match capacity configured', { exact: true })).toHaveCount(0);
  await expect(desk.getByRole('combobox', { name: 'Named station', exact: true })).toHaveCount(0);
  await desk.getByRole('button', { name: 'Call ordinary match', exact: true }).first().click();
  await expect(desk.getByText('1 / 1 in use', { exact: true })).toBeVisible();
});
