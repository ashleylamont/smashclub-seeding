import { expect, test, type APIRequestContext } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import type { trpc } from '../src/lib/trpc';
import { chooseOption } from '../test-support/controls';

type Snapshot = Awaited<ReturnType<typeof trpc.eventOps.snapshot.query>>;
async function query<T>(request: APIRequestContext, procedure: string, input = {}): Promise<T> {
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

test('independent OBS and player views follow native play, confirmed results and cancellation', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const signIn = await page.request.post('/api/auth/sign-in/email', {
    data: { email: 'admin@smashclub.dev', password: 'devpassword123' },
  });
  expect(signIn.ok()).toBe(true);
  const suffix = crypto.randomUUID().slice(0, 8);
  const entrants = [];
  for (const [name, character, icon] of [
    ['Alpha', 'mario', 'Mario'],
    ['Beta', 'link', 'Link'],
    ['Gamma', 'samus', 'Samus'],
    ['Delta', 'fox', 'Fox'],
  ]) {
    const alias = `Screen ${name} ${suffix}`;
    const { playerId } = await mutate<{ playerId: string }>(page.request, 'admin.createPlayer', {
      canonicalName: `Broadcast ${name} ${suffix}`,
      displayName: alias,
      companyCode: null,
      characters: [character],
    });
    entrants.push({ playerId, alias, icon });
  }
  const { planId } = await mutate<{ planId: string }>(
    page.request,
    'admin.eventPlanner.createPlan',
    {
      name: `Native intermission rehearsal ${suffix}`,
      eventDate: new Date().toISOString(),
      bracketMode: 'native',
      structure: 'single_elimination',
      rows: entrants.map((entrant, index) => ({
        lineNumber: index + 1,
        rawInput: entrant.alias,
        cleanedName: entrant.alias,
        playerId: entrant.playerId,
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
  await mutate(page.request, 'eventOps.settings', { planId, published: true, playerReports: true });
  const stationId = crypto.randomUUID();
  const command = (input: object) =>
    mutate(page.request, 'eventOps.live.command', {
      planId,
      requestId: crypto.randomUUID(),
      command: input,
    });
  let snapshot = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
  await command({
    kind: 'station',
    id: stationId,
    name: 'Stage',
    expectedResourceRevision: snapshot.settings.resourceRevision,
  });
  snapshot = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
  await command({
    kind: 'configureDispatch',
    capacity: 1,
    reservedStationIds: [stationId],
    expectedResourceRevision: snapshot.settings.resourceRevision,
  });
  snapshot = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
  const first = snapshot.matches.find((match) => match.status === 'ready')!;
  await page.goto(`/operate/${planId}?view=broadcast&station=${stationId}`);
  const panel = page.getByRole('tabpanel', { name: 'Broadcast', exact: true });
  await panel.getByRole('button', { name: 'Intermission browser sources', exact: true }).click();
  const link = panel.getByRole('link', { name: 'Automatic intermission overlay ↗', exact: true });
  const href = (await link.getAttribute('href'))!;
  expect(href).toContain('presentation=auto');
  expect(href).toContain(`station=${stationId}`);
  const publicContext = await browser.newContext({
    baseURL,
    viewport: { width: 1280, height: 720 },
    reducedMotion: 'reduce',
  });
  try {
    const obs = await publicContext.newPage();
    await obs.goto(href);
    const progress = obs.getByRole('region', { name: 'Tournament progress', exact: true });
    await expect(progress).toBeVisible();
    await expect(progress).toContainText(first.player1Name!);
    await obs.screenshot({ path: testInfo.outputPath('real-intermission-idle-1280.png') });
    snapshot = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
    await command({
      kind: 'dispatch',
      matchId: first.id,
      stationId,
      expectedRevision: first.revision,
      expectedResourceRevision: snapshot.settings.resourceRevision,
      callOnly: true,
    });
    await expect(panel.getByRole('button', { name: 'Finish match', exact: true })).toBeVisible();
    await obs.reload();
    await expect(progress).toBeVisible();
    snapshot = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
    await command({
      kind: 'beginPlay',
      matchId: first.id,
      expectedRevision: snapshot.matches.find((match) => match.id === first.id)!.revision,
      expectedResourceRevision: snapshot.settings.resourceRevision,
    });
    await expect(progress).not.toBeVisible();
    const capture = obs.getByRole('region', { name: 'Transparent game capture area', exact: true });
    await expect(capture).toBeVisible();
    await expect(obs.getByLabel('Current match')).toContainText(first.player1Name!);
    const aperture = (await capture.boundingBox())!;
    expect(
      await obs.evaluate(
        ({ x, y }) =>
          document
            .elementsFromPoint(x, y)
            .filter(
              (element) =>
                !['transparent', 'rgba(0, 0, 0, 0)'].includes(
                  getComputedStyle(element).backgroundColor,
                ),
            ).length,
        { x: aperture.x + aperture.width / 2, y: aperture.y + aperture.height / 2 },
      ),
    ).toBe(0);
    snapshot = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
    await mutate(page.request, 'eventOps.reportScore', {
      matchId: first.id,
      expectedRevision: snapshot.matches.find((match) => match.id === first.id)!.revision,
      requestId: crypto.randomUUID(),
      score1: 2,
      score2: 0,
      outcome: 'played',
    });
    await expect(progress).toBeVisible();
    const result = progress.locator(`[data-match-id="${first.id}"]`);
    await expect(result).toContainText('Final result');
    await expect(result.locator('.is-winner')).toContainText(first.player1Name!);
    const before = (
      await query<Snapshot>(page.request, 'eventOps.snapshot', { planId })
    ).matches.map((match) => [
      match.id,
      match.revision,
      match.score1,
      match.score2,
      match.winnerId,
    ]);
    for (const [width, height] of [
      [1280, 720],
      [1920, 1080],
    ]) {
      await obs.setViewportSize({ width, height });
      await expect
        .poll(() =>
          obs
            .locator('.intermission-content')
            .evaluate(
              (element) =>
                element.scrollHeight <= element.clientHeight + 1 &&
                element.scrollWidth <= element.clientWidth + 1,
            ),
        )
        .toBe(true);
      expect(
        (
          await new AxeBuilder({ page: obs })
            .include('.broadcast-intermission')
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      await obs.screenshot({ path: testInfo.outputPath(`real-intermission-result-${width}.png`) });
    }
    await obs.keyboard.press('s');
    const setup = obs.getByRole('dialog', { name: 'Display setup', exact: true });
    await chooseOption(
      setup.getByRole('combobox', { name: 'Broadcast presentation', exact: true }),
      'gameplay',
    );
    await setup.getByRole('button', { name: 'Hide controls', exact: true }).click();
    await expect(capture).toBeVisible();
    await expect(progress).not.toBeVisible();
    const after = (
      await query<Snapshot>(page.request, 'eventOps.snapshot', { planId })
    ).matches.map((match) => [
      match.id,
      match.revision,
      match.score1,
      match.score2,
      match.winnerId,
    ]);
    expect(after).toEqual(before);
    await obs.reload();
    await expect(capture).toBeVisible();
    await expect(obs).toHaveURL(/presentation=gameplay/);

    await obs.goto(href);
    await expect(progress).toBeVisible();
    snapshot = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
    const next = snapshot.matches.find((match) => match.status === 'ready')!;
    await command({
      kind: 'dispatch',
      matchId: next.id,
      stationId,
      expectedRevision: next.revision,
      expectedResourceRevision: snapshot.settings.resourceRevision,
      callOnly: true,
    });
    snapshot = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
    await command({
      kind: 'beginPlay',
      matchId: next.id,
      expectedRevision: snapshot.matches.find((match) => match.id === next.id)!.revision,
      expectedResourceRevision: snapshot.settings.resourceRevision,
    });
    await expect(capture).toBeVisible();
    await expect(obs.getByLabel('Current match')).toContainText(next.player1Name!);

    const hub = await publicContext.newPage();
    await hub.setViewportSize({ width: 390, height: 844 });
    const publicCode = snapshot.publicCode;
    expect(String(publicCode)).toMatch(/^[1-9]\d{6,7}$/);
    await hub.goto(`/e/${publicCode}?player=${next.player1Id}`);
    await expect(hub).toHaveURL(
      (url) =>
        url.pathname === `/play/${planId}` && url.searchParams.get('player') === next.player1Id,
    );
    const hubCard = hub.locator('article.ops-match').filter({ hasText: next.label });
    await expect(hubCard).toContainText('Playing now · Stage');

    const active = await query<Snapshot>(publicContext.request, 'eventOps.snapshot', { planId });
    await mutate(page.request, 'admin.eventPlanner.closePlan', { planId, status: 'cancelled' });
    const closed = await query<Snapshot>(publicContext.request, 'eventOps.snapshot', { planId });
    expect(closed.plan.status).toBe('cancelled');
    const retained = active.matches.find((match) => match.id === next.id)!;
    expect(retained).toMatchObject({ status: 'playing', stationId });
    expect(closed.matches.find((match) => match.id === next.id)).toMatchObject({
      status: retained.status,
      stationId: retained.stationId,
      revision: retained.revision,
      winnerId: retained.winnerId,
    });
    await expect(progress).toContainText('Event cancelled');
    await expect(capture).not.toBeVisible();
    const abandoned = progress.locator(`[data-match-id="${next.id}"]`);
    await expect(abandoned).toContainText('No result recorded');
    await expect(abandoned).not.toHaveClass(/is-playing/);
    await expect(result).toContainText('Final result');
    await expect(hubCard).toContainText('No result recorded · Stage');
    await expect(hubCard).not.toHaveClass(/ops-match-playing/);
    await expect(hubCard.getByRole('spinbutton')).toHaveCount(0);
    await expect(hub.getByRole('region', { name: 'Match calls' })).toHaveCount(0);
    const results = hub.getByRole('region', { name: 'Results', exact: true });
    await hub.getByRole('button', { name: 'Full draw & bracket standings' }).press('Enter');
    await expect(hub.locator(`[data-match-id="${next.id}"]`)).toHaveAccessibleName(
      /No result recorded/,
    );
    await expect(hub.locator(`[data-match-id="${first.id}"]`).getByLabel('Score 2')).toBeVisible();
    await expect(results.getByRole('heading', { name: 'Recorded results' })).toBeVisible();
    await hub.evaluate(() => scrollTo(0, 0));
    await hub.screenshot({
      path: testInfo.outputPath('real-player-event-cancelled.png'),
      fullPage: true,
    });
    await obs.reload();
    await expect(abandoned).toContainText('No result recorded');
    await expect(obs).toHaveURL(/presentation=auto/);
    await obs.screenshot({ path: testInfo.outputPath('real-intermission-cancelled.png') });
    await obs.keyboard.press('ArrowLeft');
    await expect(
      progress.getByRole('heading', { name: 'Recorded tournament results' }),
    ).toBeVisible();
    const shortUrl = `${new URL(obs.url()).origin}/e/${publicCode}`;
    await expect(progress).toContainText(
      `Full event information and recorded results at ${shortUrl}`,
    );
    await obs.screenshot({ path: testInfo.outputPath('real-intermission-short-link-1920.png') });
    await hub.goto(`${shortUrl}#results`);
    await expect(hub).toHaveURL(
      (url) => url.pathname === `/play/${planId}` && url.hash === '#results',
    );
    await expect(results.getByRole('heading', { name: 'Recorded results' })).toBeVisible();
    for (const path of ['/e/99999999', '/e/not-a-code']) {
      await hub.goto(path);
      await expect(hub.getByRole('alert')).toContainText(
        'This event is unavailable or has not been published.',
      );
      await expect(hub).toHaveURL((url) => url.pathname === path);
      await expect(hub.getByRole('button', { name: 'Try again' })).toHaveCount(0);
    }
  } finally {
    await publicContext.close();
  }
});
