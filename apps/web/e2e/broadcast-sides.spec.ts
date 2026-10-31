import { expect, test, type APIRequestContext } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import type { trpc } from '../src/lib/trpc';

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

test('a TO swaps a called broadcast pairing for an independent OBS viewer, retains live scores, and swaps the next match', async ({
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
      name: `Native broadcast sides ${suffix}`,
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
  await command({
    kind: 'dispatch',
    matchId: first.id,
    stationId,
    expectedRevision: first.revision,
    expectedResourceRevision: snapshot.settings.resourceRevision,
    callOnly: true,
  });
  await page.goto(`/operate/${planId}?view=broadcast&station=${stationId}`);
  const panel = page.getByRole('tabpanel', { name: 'Broadcast' });
  const preview = panel.getByRole('region', { name: 'Overlay player order' });
  await expect(preview.getByRole('group', { name: 'Left player' })).toContainText(
    first.player1Name!,
  );
  await panel.getByRole('button', { name: 'Update live score', exact: true }).click();
  const form = panel.locator('.ops-score-form');
  await form.getByRole('spinbutton').nth(0).fill('1');
  await form.getByRole('spinbutton').nth(1).fill('2');
  const publicContext = await browser.newContext({
    baseURL,
    viewport: { width: 1280, height: 720 },
  });
  try {
    const obs = await publicContext.newPage();
    const obsUrl = `/overlay/${planId}?station=${stationId}&recent=1&captureWidth=74&captureHeight=75&controls=0`;
    await obs.goto(obsUrl);
    await expect(obs.locator('.broadcast-topline')).toContainText('WAITING FOR A MATCH');
    await preview.getByRole('button', { name: 'Swap players / sides' }).click();
    await expect(preview.getByRole('group', { name: 'Left player' })).toContainText(
      first.player2Name!,
    );
    await expect(form.getByRole('spinbutton').nth(0)).toHaveValue('1');
    await expect(form.getByRole('spinbutton').nth(1)).toHaveValue('2');
    snapshot = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
    expect(snapshot.matches.find((match) => match.id === first.id)).toMatchObject({
      player1Id: first.player1Id,
      player2Id: first.player2Id,
      score1: null,
      score2: null,
      winnerId: null,
      revision: first.revision,
      started: false,
    });
    await command({
      kind: 'beginPlay',
      matchId: first.id,
      expectedRevision: first.revision,
      expectedResourceRevision: snapshot.settings.resourceRevision,
    });
    await panel.getByRole('button', { name: 'Save live score', exact: true }).click();
    const left = obs.locator('.broadcast-fighter-one'),
      right = obs.locator('.broadcast-fighter-two');
    await expect(left.locator('strong')).toHaveText(first.player2Name!);
    await expect(right.locator('strong')).toHaveText(first.player1Name!);
    await expect(left.locator('b')).toHaveText('2');
    await expect(right.locator('b')).toHaveText('1');
    await expect(
      left.getByRole('img', {
        name: `Mains ${entrants.find((entrant) => entrant.playerId === first.player2Id)!.icon}`,
      }),
    ).toBeVisible();
    await expect(
      right.getByRole('img', {
        name: `Mains ${entrants.find((entrant) => entrant.playerId === first.player1Id)!.icon}`,
      }),
    ).toBeVisible();
    const stored = await query<{
      matches: {
        id: string;
        player1Id: string;
        player2Id: string;
        liveScore1: number;
        liveScore2: number;
        revision: number;
      }[];
    }>(page.request, 'eventOps.live.snapshot', { planId });
    expect(stored.matches.find((match) => match.id === first.id)).toMatchObject({
      player1Id: first.player1Id,
      player2Id: first.player2Id,
      liveScore1: 1,
      liveScore2: 2,
      revision: first.revision,
    });
    await page.reload();
    await obs.reload();
    await expect(preview.getByRole('group', { name: 'Left player' })).toContainText(
      first.player2Name!,
    );
    await expect(left.locator('strong')).toHaveText(first.player2Name!);
    await expect(page).toHaveURL(new RegExp(`view=broadcast&station=${stationId}`));
    await expect(obs).toHaveURL(
      new RegExp(`recent=1&captureWidth=74&captureHeight=75&controls=0$`),
    );
    for (const [width, height] of [
      [1280, 720],
      [1920, 1080],
    ]) {
      await obs.setViewportSize({ width, height });
      const aperture = (await obs.getByLabel('Transparent game capture area').boundingBox())!;
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
      expect(
        await obs.evaluate(
          () =>
            document.documentElement.scrollWidth <= innerWidth &&
            document.documentElement.scrollHeight <= innerHeight,
        ),
      ).toBe(true);
      expect(
        (
          await new AxeBuilder({ page: obs })
            .include('.event-overlay')
            .withTags(['wcag2a', 'wcag2aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      await obs.screenshot({
        path: testInfo.outputPath(`shared-broadcast-sides-${width}.png`),
        omitBackground: true,
      });
    }
    expect(
      (
        await new AxeBuilder({ page })
          .include('.ops-main-stage')
          .withTags(['wcag2a', 'wcag2aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await panel.getByRole('button', { name: 'Finish match', exact: true }).click();
    await panel.locator('.ops-score-form').getByRole('spinbutton').nth(0).fill('2');
    await panel.locator('.ops-score-form').getByRole('spinbutton').nth(1).fill('0');
    await panel.getByRole('button', { name: 'Confirm result', exact: true }).click();
    const recent = obs
      .getByRole('region', { name: 'Recent resolved sets' })
      .locator(`[data-match-id="${first.id}"]`);
    await expect(recent).toBeVisible();
    await expect(recent.locator('b')).toHaveText(['2', '0']);
    snapshot = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
    expect(snapshot.matches.find((match) => match.id === first.id)).toMatchObject({
      score1: 2,
      score2: 0,
      winnerId: first.player1Id,
      status: 'complete',
    });
    const next = snapshot.matches.find((match) => match.status === 'ready')!;
    await command({
      kind: 'dispatch',
      matchId: next.id,
      stationId,
      expectedRevision: next.revision,
      expectedResourceRevision: snapshot.settings.resourceRevision,
      callOnly: false,
    });
    await expect(preview.getByRole('group', { name: 'Left player' })).toContainText(
      next.player1Name!,
    );
    await expect(left.locator('strong')).toHaveText(next.player1Name!);
    await expect(right.locator('strong')).toHaveText(next.player2Name!);
    await preview.getByRole('button', { name: 'Swap players / sides' }).click();
    await expect(preview.getByRole('group', { name: 'Left player' })).toContainText(
      next.player2Name!,
    );
    await expect(left.locator('strong')).toHaveText(next.player2Name!);
    snapshot = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
    expect(
      'broadcastSides' in snapshot ? snapshot.broadcastSides?.[stationId] : undefined,
    ).toMatchObject({ matchId: next.id, swapped: true, revision: 2 });
  } finally {
    await publicContext.close();
  }
});
