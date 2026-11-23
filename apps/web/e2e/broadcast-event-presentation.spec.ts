import { expect, test, type APIRequestContext } from '@playwright/test';
import type { trpc } from '../src/lib/trpc';
import { chooseOption } from '../test-support/controls';

type Snapshot = Awaited<ReturnType<typeof trpc.eventOps.snapshot.query>>;
type Overview = Awaited<ReturnType<typeof trpc.eventOps.overview.query>>;

async function query<T>(request: APIRequestContext, procedure: string, input?: object): Promise<T> {
  const response = await request.get(`/api/trpc/${procedure}`, {
    params: input ? { input: JSON.stringify(input) } : {},
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result.data as T;
}

async function mutate<T>(request: APIRequestContext, procedure: string, data: object): Promise<T> {
  const response = await request.post(`/api/trpc/${procedure}`, { data });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result.data as T;
}

test('assigned TO switches an open event-following OBS source independently of fixed OBS and scores', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const signIn = async (request: APIRequestContext, email: string) => {
    const response = await request.post('/api/auth/sign-in/email', {
      data: { email, password: 'devpassword123' },
    });
    expect(response.ok()).toBe(true);
  };

  await signIn(page.request, 'admin@smashclub.dev');
  const players = (
    await query<{ id: string; canonicalName: string; status: string }[]>(
      page.request,
      'admin.players',
    )
  )
    .filter((player) => player.status === 'active')
    .slice(0, 4);
  const { planId } = await mutate<{ planId: string }>(
    page.request,
    'admin.eventPlanner.createPlan',
    {
      name: 'OBS event-following rehearsal',
      eventDate: new Date().toISOString(),
      bracketMode: 'native',
      structure: 'single_elimination',
      rows: players.map((player, index) => ({
        lineNumber: index + 1,
        rawInput: player.canonicalName,
        cleanedName: player.canonicalName,
        playerId: player.id,
        companyId: null,
        resolutionMethod: 'manual',
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
  const publication = { planId, published: true, playerReports: true };
  await mutate(page.request, 'eventOps.settings', publication);

  const stationId = crypto.randomUUID();
  const command = (command: object) =>
    mutate(page.request, 'eventOps.live.command', {
      planId,
      requestId: crypto.randomUUID(),
      command,
    });
  const snapshot = (request: APIRequestContext = page.request) =>
    query<Snapshot>(request, 'eventOps.snapshot', { planId });
  const start = await snapshot();
  await command({
    kind: 'station',
    id: stationId,
    name: 'Stage',
    expectedResourceRevision: start.settings.resourceRevision,
  });
  const ready = await snapshot();
  const match = ready.matches.find((match) => match.status === 'ready')!;
  await command({
    kind: 'dispatch',
    stationId,
    matchId: match.id,
    expectedRevision: match.revision,
    expectedResourceRevision: ready.settings.resourceRevision,
  });

  const operatorEmail = 'organiser@smashclub.dev';
  const contexts = await Promise.all([
    browser.newContext({ baseURL }),
    browser.newContext({
      baseURL,
      viewport: { width: 1280, height: 720 },
      reducedMotion: 'reduce',
    }),
    browser.newContext({
      baseURL,
      viewport: { width: 1920, height: 1080 },
      reducedMotion: 'reduce',
    }),
  ]);
  const [operatorContext, followingContext, fixedContext] = contexts;
  try {
    await signIn(operatorContext.request, operatorEmail);
    const to = await operatorContext.newPage();
    const following = await followingContext.newPage();
    const fixed = await fixedContext.newPage();
    const deskPath = `/operate/${planId}?view=broadcast&station=${stationId}`;
    const presentationProcedure = '/api/trpc/eventOps.setBroadcastPresentation';
    const change = { planId, expectedRevision: 0, mode: 'progress' };
    expect((await following.request.post(presentationProcedure, { data: change })).status()).toBe(
      401,
    );
    expect((await to.request.post(presentationProcedure, { data: change })).status()).toBe(403);
    await mutate(page.request, 'eventOps.assignTo', { planId, email: operatorEmail });
    const before = await snapshot(following.request);
    expect(before.matches.find((row) => row.id === match.id)).toMatchObject({ status: 'playing' });

    await to.goto(deskPath);
    const desk = to.getByRole('tabpanel', { name: 'Broadcast', exact: true });
    await desk.getByRole('button', { name: 'Intermission browser sources' }).press('Enter');
    const link = (label: string) =>
      desk.getByRole('link', { name: `${label} ↗`, exact: true }).getAttribute('href');
    const previewUrl = (await link('Follow event overlay'))!;
    const fixedUrl = new URL((await link('Progress-only overlay'))!, baseURL);
    fixedUrl.searchParams.set('controls', '0');
    fixedUrl.searchParams.set('twitch', 'fixed_rehearsal_stream');

    let copiedUrl = '';
    await following.exposeFunction('copyFollowingSource', (value: string) => {
      copiedUrl = value;
    });
    await following.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: (value: string) => Reflect.get(window, 'copyFollowingSource')(value) },
      });
    });
    await Promise.all([following.goto(previewUrl), fixed.goto(fixedUrl.href)]);
    const openSetup = following.getByRole('button', { name: 'Display setup', exact: true });
    const setup = following.getByRole('dialog', { name: 'Display setup' });
    await openSetup.press('Enter');
    await expect(setup.getByRole('combobox', { name: 'Broadcast presentation' })).toContainText(
      'Follow event',
    );
    const timing = setup.getByRole('combobox', { name: 'Change progress page every' });
    await chooseOption(timing, '30');
    await following.reload();
    await openSetup.press('Enter');
    await expect(timing).toContainText('30 seconds');
    const eventTwitch = setup.getByRole('switch', { name: 'Use event Twitch announcement' });
    await expect(eventTwitch).not.toBeChecked();
    await eventTwitch.press('Space');
    await expect(setup.getByText('No active Twitch announcement.')).toBeVisible();
    await setup.getByRole('button', { name: 'Copy OBS source URL' }).press('Enter');
    await expect(setup.getByText('OBS source URL copied.')).toBeVisible();
    await following.goto(copiedUrl);
    await expect(openSetup).toHaveCount(0);
    const followingProgress = following.getByRole('region', { name: 'Tournament progress' });
    const fixedProgress = fixed.getByRole('region', { name: 'Tournament progress' });
    const capture = following.getByRole('region', { name: 'Transparent game capture area' });
    await expect(capture).toBeVisible();
    await expect(fixedProgress).toBeVisible();

    const sharedLink = following.getByRole('link', { name: /^twitch\.tv\// });
    const localLink = fixed.getByRole('link', { name: /^twitch\.tv\// });
    const stream = desk.getByRole('region', { name: 'Public Twitch stream' });
    const hub = await followingContext.newPage();
    const hubLink = hub.getByRole('link', { name: 'Watch on Twitch' });
    const channel = 'event_rehearsal_stream';
    const streamUrl = `https://www.twitch.tv/${channel}`;
    const announce = async () => {
      await stream.getByRole('textbox', { name: 'Twitch channel name or link' }).fill(channel);
      await stream.getByRole('button', { name: 'Announce Twitch stream' }).click();
      await expect(stream).toContainText('Shown to viewers');
    };
    await expect(sharedLink).toHaveCount(0);
    await expect(localLink).toHaveAttribute('href', 'https://www.twitch.tv/fixed_rehearsal_stream');
    await announce();
    await expect(sharedLink).toHaveAttribute('href', streamUrl);
    await hub.goto(`/play/${planId}`);
    await expect(hubLink).toHaveAttribute('href', streamUrl);

    const control = desk.getByRole('region', { name: 'Event-following presentation' });
    const selection = control.getByRole('combobox', { name: 'Event presentation' });
    const apply = control.getByRole('button', { name: 'Apply presentation' });
    const switchTo = async (mode: string, name: string) => {
      await chooseOption(selection, mode);
      await apply.press('Enter');
      await expect(control.getByRole('status')).toHaveText(`Event presentation set to ${name}.`);
    };

    await switchTo('progress', 'Progress');
    await expect(followingProgress).toBeVisible();
    await expect(capture).not.toBeVisible();
    await expect(fixedProgress).toBeVisible();
    await expect(sharedLink).toHaveAttribute('href', streamUrl);
    await expect(localLink).toHaveAttribute('href', 'https://www.twitch.tv/fixed_rehearsal_stream');
    await following.screenshot({ path: testInfo.outputPath('following-progress-1280.png') });
    await fixed.screenshot({ path: testInfo.outputPath('fixed-progress-1920.png') });
    expect(await snapshot(following.request)).toMatchObject({
      broadcastPresentationMode: 'progress',
      matches: before.matches,
      settings: before.settings,
    });
    expect(await snapshot(following.request)).not.toHaveProperty('broadcastPresentation');
    expect(
      (await query<Overview>(to.request, 'eventOps.overview', { planId })).broadcastPresentation,
    ).toEqual({ mode: 'progress', revision: 1 });

    await Promise.all([to.reload(), following.reload(), fixed.reload()]);
    await expect(selection).toContainText('Progress');
    await expect(followingProgress).toBeVisible();
    await expect(fixedProgress).toBeVisible();
    expect(
      (
        await page.request.post(presentationProcedure, {
          data: { ...change, mode: 'gameplay' },
        })
      ).status(),
    ).toBe(409);

    await expect(following).toHaveURL((url) => {
      const params = url.searchParams;
      return (
        params.get('presentation') === 'event' &&
        params.get('station') === stationId &&
        params.get('cycleSeconds') === '30' &&
        params.get('twitchMode') === 'event' &&
        params.get('controls') === '0'
      );
    });

    await switchTo('gameplay', 'Gameplay');
    await expect(capture).toBeVisible();
    await expect(followingProgress).not.toBeVisible();
    await expect(fixedProgress).toBeVisible();
    await following.screenshot({ path: testInfo.outputPath('following-gameplay-1280.png') });
    const active = (await snapshot()).matches.find((row) => row.id === match.id)!;
    await mutate(to.request, 'eventOps.reportScore', {
      matchId: match.id,
      expectedRevision: active.revision,
      requestId: crypto.randomUUID(),
      score1: 2,
      score2: 0,
      outcome: 'played',
    });
    expect((await snapshot()).matches.find((row) => row.id === match.id)).toMatchObject({
      status: 'complete',
      score1: 2,
      score2: 0,
    });
    await expect(capture).toBeVisible();
    await switchTo('auto', 'Automatic');
    await expect(followingProgress).toBeVisible();
    await expect(followingProgress.locator(`[data-match-id="${match.id}"]`)).toContainText(
      match.player1Name!,
    );
    await expect(fixedProgress).toBeVisible();

    await stream.getByRole('button', { name: 'Stop Twitch announcement' }).click();
    await expect(stream.getByRole('button', { name: 'Announce Twitch stream' })).toBeVisible();
    await Promise.all([expect(sharedLink).toHaveCount(0), hub.reload()]);
    await expect(localLink).toHaveAttribute('href', 'https://www.twitch.tv/fixed_rehearsal_stream');
    await expect(hub.getByRole('heading', { name: 'OBS event-following rehearsal' })).toBeVisible();
    await expect(hubLink).toHaveCount(0);
    await announce();
    await following.reload();
    await expect(sharedLink).toHaveAttribute('href', streamUrl);
    await mutate(page.request, 'eventOps.settings', { ...publication, published: false });
    await expect(following.getByRole('status')).toContainText(
      'This event is unavailable or has not been published.',
    );
    await expect(fixed.getByRole('status')).toContainText(
      'This event is unavailable or has not been published.',
    );
    await expect(sharedLink).toHaveCount(0);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
