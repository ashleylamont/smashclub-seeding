import {
  test as base,
  expect,
  type APIRequestContext,
  type APIResponse,
  type Page,
  type Route,
} from '@playwright/test';
import { chooseOption } from '../test-support/controls';

type Match = {
  id: string;
  label: string;
  division: string;
  poolIndex: number;
  player1Name: string;
  player2Name: string;
  status: string;
  revision: number;
  resourceRevision: number;
  score1: number | null;
  score2: number | null;
};
type Overview = {
  plan: { liveOwned: boolean };
  matches: Match[];
  stations: { id: string; name: string }[];
  stationQueues: { stationId: string; nextMatchId: string | null; currentMatchId: string | null }[];
  reports: { id: string; matchId: string; requestId: string; status: string }[];
};
type LiveState = {
  cursor: number;
  audit: { kind: string; sequence: number; command: { matchId?: string } }[];
};
type Night = { planId: string; token: string; overview: Overview };
type ScoreInput = {
  matchId: string;
  requestId: string;
  expectedRevision: number;
  score1: number;
  score2: number;
};

async function signIn(request: APIRequestContext, email = 'admin@smashclub.dev') {
  const response = await request.post('/api/auth/sign-in/email', {
    data: { email, password: 'devpassword123' },
  });
  expect(response.ok(), await response.text()).toBe(true);
}
async function query<T>(request: APIRequestContext, procedure: string, input: object): Promise<T> {
  const response = await request.get(`/api/trpc/${procedure}`, {
    params: { input: JSON.stringify(input) },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result.data as T;
}
async function mutate<T = unknown>(
  request: APIRequestContext,
  procedure: string,
  data: object,
): Promise<T> {
  const response = await request.post(`/api/trpc/${procedure}`, { data });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result.data as T;
}
const overview = (request: APIRequestContext, night: Night) =>
  query<Overview>(request, 'eventOps.overview', { planId: night.planId });
const history = (request: APIRequestContext, night: Night) =>
  query<LiveState>(request, 'eventOps.live.overview', { planId: night.planId });

async function transportError(response: Pick<APIResponse, 'json'>): Promise<string> {
  const payload = await response.json();
  const message = (Array.isArray(payload) ? payload[0] : payload).error.message;
  expect(typeof message).toBe('string');
  expect(message.length).toBeGreaterThan(0);
  return message;
}

const test = base.extend<{ night: Night }>({
  night: async ({ request }, use, testInfo) => {
    await signIn(request);
    const plans = await query<{ id: string; name: string }[]>(
      request,
      'admin.eventPlanner.plans',
      {},
    );
    const source = plans.find((plan) => plan.name === 'Nemesis · Rehearsal Night');
    expect(source, 'the harness must supply a synthetic roster').toBeTruthy();
    const roster = await query<{
      entries: { playerId: string; playerName: string; companyId?: string | null }[];
    }>(request, 'admin.eventPlanner.plan', { planId: source!.id });
    const { planId } = await mutate<{ planId: string }>(request, 'admin.eventPlanner.createPlan', {
      name: `Transport rehearsal · ${testInfo.title}`,
      bracketMode: 'native',
      eventDate: '2026-10-08T09:00:00.000Z',
      upperTargetSize: 4,
      rows: roster.entries.slice(0, 8).map((entry, index) => ({
        lineNumber: index + 1,
        rawInput: entry.playerName,
        cleanedName: entry.playerName,
        playerId: entry.playerId,
        companyId: entry.companyId ?? null,
        resolutionMethod: 'manual',
        divisionPreference: 'auto',
      })),
    });
    for (const procedure of [
      'admin.eventPlanner.freezeRoster',
      'admin.eventPlanner.generatePools',
      'eventOps.prepare',
    ])
      await mutate(request, procedure, { planId });
    await mutate(request, 'eventOps.softLockPools', { planId, confirm: true });
    await mutate(request, 'eventOps.settings', { planId, published: true, playerReports: true });
    await mutate(request, 'eventOps.assignTo', { planId, email: 'organiser@smashclub.dev' });
    await mutate(request, 'eventOps.saveStation', { planId, name: 'Stage' });
    await mutate(request, 'eventOps.guests.configure', {
      planId,
      enabled: true,
      showOnOverlay: false,
    });
    const { token } = await mutate<{ token: string }>(request, 'eventOps.guests.invitation', {
      planId,
    });
    const data = await query<Overview>(request, 'eventOps.overview', { planId });
    expect(data.plan.liveOwned, 'these flows must use the merged Act runtime').toBe(true);
    expect(data.matches.every((match) => match.status === 'ready')).toBe(true);
    await use({ planId, token, overview: data });
  },
});

async function openGuest(page: Page, night: Night) {
  await page.goto(`/guest/${night.planId}#token=${encodeURIComponent(night.token)}`);
  await chooseOption(page.getByLabel('Match view', { exact: true }), 'matches');
  await expect(page.locator('article.ops-match').first()).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
}
const guestCard = (page: Page, match: Match) =>
  page.locator('article.ops-match').filter({
    has: page.getByRole('heading', {
      name: `${match.player1Name} vs ${match.player2Name}`,
      exact: true,
    }),
  });
const operatorCard = (page: Page, match: Match) =>
  page
    .locator('article.ops-match:visible')
    .filter({ hasText: match.label })
    .filter({ hasText: match.player1Name })
    .filter({ hasText: match.player2Name });
async function openDesk(page: Page, night: Night, email: string) {
  await signIn(page.request, email);
  await page.goto(`/operate/${night.planId}`);
  await chooseOption(
    page
      .getByRole('tabpanel', { name: 'Run matches' })
      .getByRole('combobox', { name: 'View', exact: true }),
    'all',
  );
}
async function editFinal(page: Page, match: Match, first: number, second: number) {
  const card = operatorCard(page, match);
  await card.getByRole('button', { name: 'Finish match', exact: true }).click();
  await card.getByRole('spinbutton').nth(0).fill(String(first));
  await card.getByRole('spinbutton').nth(1).fill(String(second));
  return card;
}
function batchInput<T>(route: Route): T {
  const body = route.request().postDataJSON();
  return new URL(route.request().url()).searchParams.has('batch') ? body[0] : body;
}

/** Delay background read delivery so polling cannot conceal a transport retry bug. */
async function delaySnapshots(page: Page) {
  const cached = new Map<string, APIResponse>();
  let delayed = false;
  await page.route(/\/api\/trpc\/eventOps\.(snapshot|guests\.matches)(?:\?|$)/, async (route) => {
    const key = route.request().url();
    if (delayed) {
      expect(cached.has(key), 'only a previously observed real snapshot may be delayed').toBe(true);
      await route.fulfill({ response: cached.get(key)! });
      return;
    }
    const response = await route.fetch();
    if (!delayed) cached.set(key, response);
    await route.fulfill({ response: delayed ? cached.get(key)! : response });
  });
  return {
    async delay() {
      await expect.poll(() => cached.size).toBe(2);
      delayed = true;
    },
    resume() {
      delayed = false;
    },
  };
}

for (const automatic of [false, true]) {
  test(`guest retries a committed ${automatic ? 'automatic result' : 'pending report'} after its acknowledgement is lost`, async ({
    page,
    request,
    night,
  }) => {
    if (automatic)
      await mutate(request, 'eventOps.settings', {
        planId: night.planId,
        published: true,
        playerReports: true,
        scoreReportingMode: 'approve_unless_disputed',
      });
    const reads = await delaySnapshots(page);
    await openGuest(page, night);
    await reads.delay();
    const match = night.overview.matches[0]!;
    const before = await history(request, night);
    const attempts: ScoreInput[] = [];
    const replies: unknown[] = [];
    await page.route('**/api/trpc/eventOps.guests.submit*', async (route) => {
      attempts.push(batchInput<ScoreInput>(route));
      const response = await route.fetch(); // The real mutation commits before delivery is cut.
      expect(response.ok(), await response.text()).toBe(true);
      replies.push(await response.json());
      if (attempts.length === 1) await route.abort('connectionreset');
      else await route.fulfill({ response });
    });
    const card = guestCard(page, match);
    await card.getByRole('spinbutton').nth(0).fill('2');
    await card.getByRole('spinbutton').nth(1).fill('1');
    const submit = card.getByRole('button', {
      name: automatic ? 'Confirm result' : 'Submit score for TO approval',
      exact: true,
    });
    await submit.click();
    await expect(card.getByRole('alert')).toContainText(/fetch|network|connection/i);
    await expect(submit).toBeEnabled();
    const committed = await overview(request, night);
    expect(committed.reports.filter((report) => report.matchId === match.id)).toHaveLength(1);
    expect(committed.matches.find((item) => item.id === match.id)).toMatchObject({
      status: automatic ? 'complete' : 'ready',
      revision: match.revision + (automatic ? 1 : 0),
      score1: automatic ? 2 : null,
      score2: automatic ? 1 : null,
    });
    await submit.click();
    await expect.poll(() => attempts.length).toBe(2);
    await expect.poll(() => replies.length).toBe(2);
    await expect(submit).toHaveCount(0);
    await expect(card.getByRole('alert')).toHaveCount(0);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(attempts[0]).toMatchObject({
      matchId: match.id,
      expectedRevision: match.revision,
      score1: 2,
      score2: 1,
    });
    expect(attempts[0]!.requestId).toBeTruthy();
    expect(replies[1]).toEqual(replies[0]);
    const after = await history(request, night);
    expect(after.cursor).toBe(before.cursor + 1);
    expect(
      after.audit.filter((entry) => entry.kind === 'score' && entry.command.matchId === match.id),
    ).toHaveLength(1);
    expect(await overview(request, night)).toEqual(committed);
    reads.resume();
    await expect(card).toContainText(
      automatic ? 'Confirmed result: 2 – 1' : 'Awaiting TO approval',
    );
    await page.reload();
    await expect(guestCard(page, match)).toContainText(
      automatic ? 'Confirmed result: 2 – 1' : 'Awaiting TO approval',
    );
    expect(
      (await overview(request, night)).reports.filter((report) => report.matchId === match.id),
    ).toHaveLength(1);
  });
}

for (const actor of ['guest', 'player']) {
  test(`${actor} preserves an unsent score across offline polling and a station dispatch`, async ({
    page,
    context,
    request,
    night,
  }) => {
    if (actor === 'guest') await openGuest(page, night);
    else {
      await signIn(page.request, 'player@smashclub.dev');
      await page.goto(`/play/${night.planId}`);
      await chooseOption(page.getByLabel('Match view', { exact: true }), 'all');
    }
    const submitName =
      actor === 'guest' ? 'Submit score for TO approval' : 'Submit score for approval';
    const match = night.overview.matches[0]!;
    const card = guestCard(page, match);
    await card.getByRole('spinbutton').nth(0).fill('2');
    await card.getByRole('spinbutton').nth(1).fill('1');
    await context.setOffline(true);
    try {
      await expect(
        page.getByRole('alert').filter({ hasText: 'Live updates interrupted' }),
      ).toBeVisible();
      await expect(card.getByRole('button', { name: submitName })).toHaveCount(0);
      await mutate(request, 'eventOps.updateMatch', {
        matchId: match.id,
        expectedRevision: match.revision,
        status: 'playing',
        stationId: night.overview.stations[0]!.id,
      });
    } finally {
      await context.setOffline(false);
    }
    await expect(
      page.getByRole('alert').filter({ hasText: 'Live updates interrupted' }),
    ).toHaveCount(0);
    await expect(card).toContainText('Stage');
    await expect(card.getByRole('spinbutton').nth(0)).toHaveValue('2');
    await expect(card.getByRole('spinbutton').nth(1)).toHaveValue('1');
    expect((await overview(request, night)).reports).toHaveLength(0);
    await card.getByRole('button', { name: submitName }).click();
    await expect(card).toContainText(
      actor === 'guest' ? 'Awaiting TO approval' : 'Score submitted for TO approval',
    );
    const after = await overview(request, night);
    expect(after.reports).toHaveLength(1);
    expect(after.matches.find((item) => item.id === match.id)).toMatchObject({
      status: 'playing',
      revision: match.revision,
    });
  });
}

test('reconnected TO retains its draft but must reopen after another TO records the result', async ({
  page,
  context,
  request,
  night,
}) => {
  await openDesk(page, night, 'organiser@smashclub.dev');
  const match = night.overview.matches[0]!;
  const card = await editFinal(page, match, 2, 1);
  await context.setOffline(true);
  try {
    await expect(
      page.getByRole('alert').filter({ hasText: 'Live updates interrupted' }),
    ).toBeVisible();
    await expect(card.getByRole('button', { name: 'Confirm result', exact: true })).toBeDisabled();
    await mutate(request, 'eventOps.reportScore', {
      matchId: match.id,
      expectedRevision: match.revision,
      requestId: 'other-to-offline-result',
      score1: 0,
      score2: 2,
      outcome: 'played',
    });
  } finally {
    await context.setOffline(false);
  }
  await expect(card.getByRole('alert')).toContainText('Another TO updated this match');
  await expect(card.getByRole('spinbutton').nth(0)).toHaveValue('2');
  await expect(card.getByRole('spinbutton').nth(1)).toHaveValue('1');
  await expect(card.getByRole('button', { name: 'Confirm result', exact: true })).toBeDisabled();
  expect((await overview(request, night)).reports).toHaveLength(1);
  await card.getByRole('button', { name: 'Cancel', exact: true }).click();
  await card.getByRole('button', { name: 'Correct score', exact: true }).click();
  await expect(card.getByRole('spinbutton').nth(0)).toHaveValue('0');
  await expect(card.getByRole('spinbutton').nth(1)).toHaveValue('2');
  await expect(card.getByRole('alert')).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Confirm result', exact: true })).toBeEnabled();
});

test('live board and OBS recover a result missed while disconnected without a reload', async ({
  browser,
  baseURL,
  request,
  night,
}) => {
  const screens = await browser.newContext({ baseURL });
  try {
    const board = await screens.newPage();
    const overlay = await screens.newPage();
    await board.goto(`/live/${night.planId}`);
    await overlay.goto(`/overlay/${night.planId}`);
    for (const page of [board, overlay])
      await expect(page.getByRole('progressbar', { name: 'Sets completed' })).toHaveAttribute(
        'value',
        '0',
      );
    await screens.setOffline(true);
    await expect(board.locator('.event-connection')).toContainText(/interrupted/i);
    await expect(overlay.locator('.broadcast-offline')).toBeVisible();
    const match = night.overview.matches[0]!;
    await mutate(request, 'eventOps.reportScore', {
      matchId: match.id,
      expectedRevision: match.revision,
      requestId: 'missed-board-result',
      score1: 2,
      score2: 0,
      outcome: 'played',
    });
    for (const page of [board, overlay])
      await expect(page.getByRole('progressbar', { name: 'Sets completed' })).toHaveAttribute(
        'value',
        '0',
      );
    await screens.setOffline(false);
    for (const page of [board, overlay])
      await expect(page.getByRole('progressbar', { name: 'Sets completed' })).toHaveAttribute(
        'value',
        '1',
      );
    await expect(board.locator('.event-connection')).not.toContainText(/interrupted/i);
    await expect(overlay.locator('.broadcast-offline')).toHaveCount(0);
    const result = board
      .locator('.event-recent article.event-match')
      .filter({ hasText: match.player1Name })
      .filter({ hasText: match.player2Name });
    await expect(result.locator('.event-contender strong')).toHaveText(['2', '0']);
    expect((await overview(request, night)).reports).toHaveLength(1);
  } finally {
    await screens.close();
  }
});

/** Both UI mutations reach the transport before either is allowed to commit. */
async function simultaneous<T>(
  pages: Page[],
  procedure: string,
  click: (page: Page) => Promise<void>,
) {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const inputs: T[] = [];
  for (const page of pages)
    await page.route(`**/api/trpc/${procedure}*`, async (route) => {
      inputs.push(batchInput<T>(route));
      await gate;
      await route.continue();
    });
  const responses = pages.map((page) =>
    page.waitForResponse((response) => response.url().includes(`/api/trpc/${procedure}`)),
  );
  try {
    await Promise.all(pages.map(click));
    await expect.poll(() => inputs.length).toBe(2);
    release();
    return { inputs, responses: await Promise.all(responses) };
  } finally {
    release();
  }
}

test('two TO score forms race: one result commits and the other explains the conflict', async ({
  browser,
  baseURL,
  request,
  night,
}) => {
  const contexts = await Promise.all([
    browser.newContext({ baseURL }),
    browser.newContext({ baseURL }),
  ]);
  try {
    const pages = await Promise.all(contexts.map((context) => context.newPage()));
    const match = night.overview.matches[0]!;
    await openDesk(pages[0]!, night, 'admin@smashclub.dev');
    await openDesk(pages[1]!, night, 'organiser@smashclub.dev');
    await editFinal(pages[0]!, match, 2, 1);
    await editFinal(pages[1]!, match, 0, 2);
    const before = await history(request, night);
    const { inputs, responses } = await simultaneous<ScoreInput>(
      pages,
      'eventOps.reportScore',
      async (page) => {
        await operatorCard(page, match)
          .getByRole('button', { name: 'Confirm result', exact: true })
          .click();
      },
    );
    expect(responses.map((response) => response.status()).sort()).toEqual([200, 409]);
    expect(
      inputs.every(
        (input) => input.expectedRevision === match.revision && input.matchId === match.id,
      ),
    ).toBe(true);
    expect(new Set(inputs.map((input) => input.requestId)).size).toBe(2);
    const winner = responses.findIndex((response) => response.status() === 200);
    const loser = pages[1 - winner]!;
    await expect(
      loser
        .getByRole('alert')
        .filter({ hasText: await transportError(responses[1 - winner]!) })
        .first(),
    ).toBeVisible();
    await expect(
      operatorCard(loser, match).getByRole('button', { name: 'Confirm result', exact: true }),
    ).toBeDisabled();
    const after = await overview(request, night);
    expect(after.matches.find((item) => item.id === match.id)).toMatchObject({
      status: 'complete',
      revision: match.revision + 1,
      score1: winner === 0 ? 2 : 0,
      score2: winner === 0 ? 1 : 2,
    });
    expect(after.reports).toHaveLength(1);
    expect(after.reports[0]!.requestId).toBe(
      inputs.find((input) => input.score1 === (winner === 0 ? 2 : 0))!.requestId,
    );
    expect((await history(request, night)).cursor).toBe(before.cursor + 1);
    for (const page of pages)
      await expect(operatorCard(page, match).locator('.ops-contestant b')).toHaveText(
        winner === 0 ? ['2', '1'] : ['0', '2'],
      );
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test('two guest station starts race without double-booking or starting the next pairing', async ({
  browser,
  baseURL,
  request,
  night,
}) => {
  const station = night.overview.stations[0]!;
  const first = night.overview.matches[0]!;
  await mutate(request, 'eventOps.configurePool', {
    planId: night.planId,
    division: first.division,
    poolIndex: first.poolIndex,
    active: true,
    selfRun: true,
    autoAcceptScores: true,
    stationIds: [station.id],
    expectedRevision: 0,
  });
  const configured = await overview(request, night);
  const next = configured.stationQueues.find(
    (queue) => queue.stationId === station.id,
  )!.nextMatchId;
  expect(next).toBeTruthy();
  const contexts = await Promise.all([
    browser.newContext({ baseURL }),
    browser.newContext({ baseURL }),
  ]);
  try {
    const pages = await Promise.all(contexts.map((context) => context.newPage()));
    for (const page of pages) await openGuest(page, night);
    const queue = (page: Page) =>
      page
        .locator('article.pool-flow-station')
        .filter({ has: page.getByRole('heading', { name: station.name, exact: true }) });
    const before = await history(request, night);
    const { inputs, responses } = await simultaneous<{ matchId: string; expectedRevision: number }>(
      pages,
      'eventOps.guests.startPoolMatch',
      async (page) => {
        await queue(page)
          .getByRole('button', { name: 'We’re here — start match', exact: true })
          .click();
      },
    );
    expect(inputs.every((input) => input.matchId === next)).toBe(true);
    expect(responses.map((response) => response.status()).sort()).toEqual([200, 409]);
    const loserIndex = responses.findIndex((response) => response.status() === 409);
    const loser = pages[loserIndex]!;
    await expect(
      loser
        .getByRole('alert')
        .filter({ hasText: await transportError(responses[loserIndex]!) })
        .first(),
    ).toBeVisible();
    const after = await overview(request, night);
    expect(
      after.matches.filter((match) => match.status === 'playing').map((match) => match.id),
    ).toEqual([next]);
    expect(
      after.stationQueues.find((queue) => queue.stationId === station.id)!.currentMatchId,
    ).toBe(next);
    expect(after.reports).toHaveLength(0);
    const final = await history(request, night);
    expect(final.cursor).toBe(before.cursor + 1);
    expect(
      final.audit.filter((entry) => entry.kind === 'dispatch' && entry.command.matchId === next),
    ).toHaveLength(1);
    for (const page of pages) {
      await expect(queue(page).locator('header')).toContainText('Playing now');
      await expect(
        queue(page).getByRole('button', { name: 'We’re here — start match', exact: true }),
      ).toHaveCount(0);
    }
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
