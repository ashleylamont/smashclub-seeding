import { expect, test, type APIRequestContext } from '@playwright/test';
import type { trpc } from '../src/lib/trpc';
import { chooseOption } from '../test-support/controls';

type Source = NonNullable<Awaited<ReturnType<typeof trpc.public.tournament.query>>>;
type Snapshot = Awaited<ReturnType<typeof trpc.eventOps.snapshot.query>>;

async function read<T>(request: APIRequestContext, procedure: string, input: object): Promise<T> {
  const response = await request.get(`/api/trpc/${procedure}`, {
    params: { input: JSON.stringify(input) },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result.data as T;
}

async function write<T = unknown>(
  request: APIRequestContext,
  procedure: string,
  data: object,
): Promise<T> {
  const response = await request.post(`/api/trpc/${procedure}`, { data });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result.data as T;
}

test('a synced linked final keeps its identifier and score across player, TO, paper and OBS', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const signIn = await page.request.post('/api/auth/sign-in/email', {
    data: { email: 'admin@smashclub.dev', password: 'devpassword123' },
  });
  expect(signIn.ok()).toBe(true);
  // The harness seeds this provider module through the normal Challonge parser and sync.
  const slug = 'dev-weekly-4';
  const source = await read<Source>(page.request, 'public.tournament', { slug });
  const roster = [
    ...new Map(source.participants.filter((p) => p.playerId).map((p) => [p.playerId, p])).values(),
  ];
  expect(roster.length).toBeGreaterThanOrEqual(8);
  const { planId } = await write<{ planId: string }>(
    page.request,
    'admin.eventPlanner.createPlan',
    {
      name: `Linked caption rehearsal ${crypto.randomUUID().slice(0, 8)}`,
      eventDate: new Date().toISOString(),
      bracketMode: 'challonge',
      upperTargetSize: Math.ceil(roster.length / 2),
      rows: roster.map((p, index) => ({
        lineNumber: index + 1,
        playerId: p.playerId,
        rawInput: p.name,
        cleanedName: p.name,
        companyId: null,
        resolutionMethod: 'manual',
      })),
    },
  );
  for (const procedure of ['admin.eventPlanner.freezeRoster', 'admin.eventPlanner.generatePools'])
    await write(page.request, procedure, { planId });
  await write(page.request, 'admin.eventPlanner.attachBracket', {
    planId,
    division: 'upper',
    stage: 'main',
    challongeSlug: slug,
  });
  await write(page.request, 'eventOps.prepare', { planId });
  await write(page.request, 'eventOps.settings', { planId, published: true, playerReports: true });

  const viewer = await browser.newContext({ baseURL, reducedMotion: 'reduce' });
  try {
    const snapshot = await read<Snapshot>(viewer.request, 'eventOps.snapshot', { planId });
    const sources = new Map(source.sets.map((set) => [set.id, set]));
    const match = snapshot.matches.find(
      (row) => row.sourceSetId && row.stage === 'main' && row.outcome === 'played',
    )!;
    const imported = sources.get(match.sourceSetId!)!;
    expect(imported.identifier).toBeTruthy();
    expect(match).toMatchObject({
      sourceKey: `set:${imported.id}`,
      label: `upper main · ${imported.identifier}`,
      nativeBracketId: null,
    });
    const caption = `Upper Championship · ${imported.identifier}`;
    await page.goto(`/operate/${planId}?view=run`);
    const run = page.getByRole('tabpanel', { name: 'Run matches' });
    await chooseOption(run.getByRole('combobox', { name: 'View', exact: true }), 'complete');
    const search = run.getByRole('textbox', { name: 'Find a player or match' });
    const toCard = run.locator('article.ops-match').filter({
      has: page.getByRole('combobox', { name: `Station for ${caption}`, exact: true }),
    });
    for (const term of [match.label, caption]) {
      await search.fill(term);
      await expect(toCard.getByText(caption, { exact: true })).toBeVisible();
    }
    await expect(toCard.locator('.ops-contestant b')).toHaveText([
      String(match.score1),
      String(match.score2),
    ]);
    await toCard.screenshot({ path: testInfo.outputPath('linked-import-to-card.png') });
    await run.getByRole('button', { name: 'Pool queues and stations', exact: true }).press('Enter');
    const trigger = run.getByRole('button', { name: 'Print bracket backup sheets', exact: true });
    await trigger.press('Enter');
    const print = page.getByRole('dialog', { name: 'Print bracket backup sheets' });
    const sheet = print.locator('.bracket-backup-page').filter({
      has: page.getByRole('heading', { name: 'Upper Championship', exact: true }),
    });
    const paperRow = sheet.getByRole('row').filter({
      has: page.getByRole('cell', { name: imported.identifier!, exact: true }),
    });
    await expect(paperRow).toContainText(`Online: ${match.score1}–${match.score2}`);
    await expect(paperRow).not.toContainText(match.label);
    await page.emulateMedia({ media: 'print' });
    await expect(paperRow).toBeVisible();
    await page.pdf({
      format: 'A4',
      preferCSSPageSize: true,
      path: testInfo.outputPath('linked-bracket-backup.pdf'),
    });
    await page.emulateMedia({ media: 'screen' });
    await print.getByRole('button', { name: 'Close preview', exact: true }).click();
    await expect(trigger).toBeFocused();

    const hub = await viewer.newPage();
    await hub.setViewportSize({ width: 390, height: 844 });
    await hub.goto(`/play/${planId}?match=${match.id}#my-matches`);
    const card = hub.locator('article.ops-match').filter({ hasText: caption });
    await expect(card.getByText(caption, { exact: true })).toBeVisible();
    await expect(card).toContainText(`Confirmed result: ${match.score1} – ${match.score2}`);
    await expect(card).not.toContainText(match.label);
    await card.scrollIntoViewIfNeeded();
    await hub.screenshot({ path: testInfo.outputPath('linked-import-player.png') });

    const obs = await viewer.newPage();
    await obs.setViewportSize({ width: 1280, height: 720 });
    await obs.goto(`/overlay/${planId}?presentation=gameplay&controls=0`);
    const recent = obs.locator('.broadcast-recent-sets article').first();
    await expect(recent).toBeVisible();
    const recentId = await recent.getAttribute('data-match-id');
    const recentMatch = snapshot.matches.find(({ id }) => id === recentId)!;
    const recentSet = sources.get(recentMatch.sourceSetId!)!;
    await expect(recent.locator('small')).toHaveText(
      `Upper Championship · ${recentSet.identifier}`,
    );
    await obs.screenshot({ path: testInfo.outputPath('linked-import-obs-gameplay.png') });

    await obs.goto(`/overlay/${planId}?presentation=progress&controls=0`);
    await expect(obs.getByRole('region', { name: 'Tournament progress' })).toBeVisible();
    const bracket = obs.getByRole('table', { name: 'Linked Upper Championship bracket' });
    for (let page = 0; page < 24 && !(await bracket.isVisible()); page++)
      await obs.keyboard.press('ArrowRight');
    await expect(
      bracket.getByRole('cell', { name: imported.identifier!, exact: true }),
    ).toBeVisible();
    await obs.screenshot({ path: testInfo.outputPath('linked-import-obs-progress.png') });

    const after = await read<Snapshot>(viewer.request, 'eventOps.snapshot', { planId });
    expect(after.matches.find(({ id }) => id === match.id)).toEqual(match);
    const sourceAfter = await read<Source>(viewer.request, 'public.tournament', { slug });
    expect(sourceAfter.sets.find(({ id }) => id === imported.id)).toEqual(imported);
  } finally {
    await viewer.close();
  }
});
