import { expect, test, type APIRequestContext } from '@playwright/test';
import type { trpc } from '../src/lib/trpc';
import { chooseOption } from '../test-support/controls';

type Snapshot = Awaited<ReturnType<typeof trpc.eventOps.snapshot.query>>;

async function snapshot(request: APIRequestContext, planId: string) {
  const response = await request.get('/api/trpc/eventOps.snapshot', {
    params: { input: JSON.stringify({ planId }) },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result.data as Snapshot;
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

async function signIn(request: APIRequestContext, email: string) {
  const response = await request.post('/api/auth/sign-in/email', {
    data: { email, password: 'devpassword123' },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function prepareEvent(request: APIRequestContext) {
  await signIn(request, 'admin@smashclub.dev');
  const suffix = crypto.randomUUID().slice(0, 8);
  const rows = [];
  for (const [index, name] of ['Alpha', 'Beta', 'Gamma', 'Delta'].entries()) {
    const alias = `Stage rehearsal ${name} ${suffix}`;
    const { playerId } = await mutate<{ playerId: string }>(request, 'admin.createPlayer', {
      canonicalName: alias,
      displayName: alias,
      companyCode: null,
    });
    rows.push({
      lineNumber: index + 1,
      rawInput: alias,
      cleanedName: alias,
      playerId,
      companyId: null,
      resolutionMethod: 'manual',
    });
  }
  const { planId } = await mutate<{ planId: string }>(request, 'admin.eventPlanner.createPlan', {
    name: `Broadcast station rehearsal ${suffix}`,
    eventDate: new Date().toISOString(),
    bracketMode: 'native',
    structure: 'single_elimination',
    rows,
  });
  for (const procedure of [
    'admin.eventPlanner.freezeRoster',
    'admin.eventPlanner.generatePools',
    'eventOps.softLockPools',
    'eventOps.prepare',
  ])
    await mutate(request, procedure, {
      planId,
      ...(procedure === 'eventOps.softLockPools' ? { confirm: true } : {}),
    });
  await mutate(request, 'eventOps.assignTo', { planId, email: 'organiser@smashclub.dev' });
  await mutate(request, 'eventOps.settings', { planId, published: true, playerReports: true });
  const command = async (input: object) =>
    mutate(request, 'eventOps.live.command', {
      planId,
      requestId: crypto.randomUUID(),
      command: {
        ...input,
        expectedResourceRevision: (await snapshot(request, planId)).settings.resourceRevision,
      },
    });
  return { planId, command };
}

test('the assigned Broadcast desk and stationless overlay follow the same default station', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const { planId, command } = await prepareEvent(page.request);
  const floorId = crypto.randomUUID();
  const stageId = crypto.randomUUID();
  const deskUrl = `/operate/${planId}?view=broadcast`;
  const overlayUrl = `/overlay/${planId}?controls=0`;
  const operator = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  const publicContext = await browser.newContext({
    baseURL,
    viewport: { width: 1920, height: 1080 },
    reducedMotion: 'reduce',
  });

  try {
    await signIn(operator.request, 'organiser@smashclub.dev');
    const desk = await operator.newPage();
    const overlay = await publicContext.newPage();
    const panel = desk.getByRole('tabpanel', { name: 'Broadcast', exact: true });
    const station = panel.getByRole('combobox', { name: 'Station', exact: true });
    const overlayLink = panel.getByRole('link', { name: 'Open station overlay ↗', exact: true });
    const progress = overlay.getByRole('region', { name: 'Tournament progress', exact: true });
    const currentMatch = overlay.getByLabel('Current match', { exact: true });
    const finish = panel.getByRole('button', { name: 'Finish match', exact: true });
    const headline = overlay.locator('.broadcast-topline');

    await Promise.all([desk.goto(deskUrl), overlay.goto(overlayUrl)]);
    await expect(station).toContainText('No stations configured');
    await expect(overlayLink).toHaveAttribute('href', `/overlay/${planId}`);
    await expect(progress).toBeVisible();

    await command({ kind: 'station', id: floorId, name: 'Floor 1' });
    await command({ kind: 'station', id: stageId, name: 'Floor 2' });
    await command({
      kind: 'configureDispatch',
      capacity: 1,
      reservedStationIds: [floorId, stageId],
    });
    await Promise.all([desk.goto(deskUrl), overlay.goto(`${overlayUrl}&presentation=gameplay`)]);
    await expect(station).toHaveAttribute('data-value', floorId);
    await expect(overlayLink).toHaveAttribute('href', `/overlay/${planId}?station=${floorId}`);
    await expect(headline.getByText('Floor 1', { exact: true })).toBeVisible();

    const stageName = 'sTaGe';
    await command({ kind: 'station', id: stageId, name: stageName });
    const before = await snapshot(publicContext.request, planId);
    expect(before.stations.map(({ id }) => id)).toEqual([floorId, stageId]);
    const first = before.matches.find((match) => match.status === 'ready')!;

    await Promise.all([desk.goto(deskUrl), overlay.goto(overlayUrl)]);
    await expect(station).toHaveAttribute('data-value', stageId);
    await expect(overlayLink).toHaveAttribute('href', `/overlay/${planId}?station=${stageId}`);
    await expect(progress).toBeVisible();
    await chooseOption(panel.getByRole('combobox', { name: 'Ready pairing' }), first.id);
    await panel.getByRole('button', { name: `Start on ${stageName}`, exact: true }).press('Enter');
    await expect(finish).toBeVisible();
    expect(
      (await snapshot(publicContext.request, planId)).matches.find(({ id }) => id === first.id),
    ).toMatchObject({ stationId: stageId, started: true });
    await expect(currentMatch).toContainText(first.player1Name!);
    await expect(progress).not.toBeVisible();

    // A cold explicit link must keep Floor 1 while the default source stays on Stage.
    const explicitDesk = await operator.newPage();
    const explicitOverlay = await publicContext.newPage();
    await Promise.all([
      explicitDesk.goto(`${deskUrl}&station=${floorId}`),
      explicitOverlay.goto(`${overlayUrl}&station=${floorId}&presentation=gameplay`),
    ]);
    await expect(
      explicitDesk.getByRole('combobox', { name: 'Station', exact: true }),
    ).toHaveAttribute('data-value', floorId);
    await expect(
      explicitOverlay.locator('.broadcast-topline').getByText('Floor 1', { exact: true }),
    ).toBeVisible();
    await expect(explicitOverlay.getByLabel('Current match', { exact: true })).toHaveCount(0);

    await Promise.all([
      explicitDesk.goto(`${deskUrl}&station=missing-station`),
      explicitOverlay.goto(`${overlayUrl}&station=missing-station&presentation=gameplay`),
    ]);
    await expect(
      explicitDesk.getByRole('combobox', { name: 'Station', exact: true }),
    ).toHaveAttribute('data-value', floorId);
    await expect(explicitOverlay.getByText('WAITING FOR A MATCH', { exact: true })).toBeVisible();
    await expect(explicitOverlay.getByLabel('Current match', { exact: true })).toHaveCount(0);
    await explicitDesk.close();
    await explicitOverlay.close();

    await desk.screenshot({ path: testInfo.outputPath('desk-stage-desktop.png'), fullPage: true });
    await desk.setViewportSize({ width: 390, height: 844 });
    await panel.getByRole('button', { name: 'Update live score', exact: true }).click();
    const scores = panel.locator('.ops-score-form').getByRole('spinbutton');
    await scores.nth(0).fill('1');
    await scores.nth(1).fill('0');
    await panel.getByRole('button', { name: 'Save live score', exact: true }).click();
    const left = overlay.locator('.broadcast-fighter-one');
    const right = overlay.locator('.broadcast-fighter-two');
    await expect(left.locator('b')).toHaveText('1');
    await expect(right.locator('b')).toHaveText('0');
    await panel.getByRole('button', { name: 'Swap players / sides', exact: true }).click();
    await expect(right.locator('strong')).toHaveText(first.player1Name!);
    await expect(right.locator('b')).toHaveText('1');
    await overlay.screenshot({
      path: testInfo.outputPath('obs-stage-playing.png'),
      omitBackground: true,
    });
    await desk.evaluate(() => window.scrollTo(0, 0));
    await desk.screenshot({ path: testInfo.outputPath('desk-stage-phone.png'), fullPage: true });

    await finish.click();
    await scores.nth(0).fill('2');
    await scores.nth(1).fill('0');
    await panel.getByRole('button', { name: 'Confirm result', exact: true }).click();
    await expect(
      progress.getByRole('heading', { name: 'Recent results', exact: true }),
    ).toBeVisible();
    const result = (await snapshot(publicContext.request, planId)).matches.find(
      ({ id }) => id === first.id,
    );
    expect(result).toMatchObject({
      score1: 2,
      score2: 0,
      winnerId: first.player1Id,
      status: 'complete',
    });
    await overlay.screenshot({ path: testInfo.outputPath('obs-stage-result.png') });
  } finally {
    await publicContext.close();
    await operator.close();
  }
});
