import { writeFile } from 'node:fs/promises';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import type { trpc } from '../src/lib/trpc';

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

test('a phone TO prints backed-up and published native draws without changing results', async ({
  page,
  request,
}, testInfo) => {
  const login = await request.post('/api/auth/sign-in/email', {
    data: { email: 'admin@smashclub.dev', password: 'devpassword123' },
  });
  expect(login.ok()).toBe(true);
  const players = (
    await rpc<{ id: string; canonicalName: string; status: string }[]>(request, 'admin.players', {})
  )
    .filter((p) => p.status === 'active')
    .slice(0, 5);
  const name = 'TO draw and print rehearsal';
  const { planId } = await rpc<{ planId: string }>(
    request,
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
      request,
      procedure,
      { planId, ...(procedure === 'eventOps.softLockPools' ? { confirm: true } : {}) },
      true,
    );
  await rpc(request, 'eventOps.settings', { planId, published: true, playerReports: true }, true);
  const snapshot = () =>
    rpc<Awaited<ReturnType<typeof trpc.eventOps.snapshot.query>>>(request, 'eventOps.snapshot', {
      planId,
    });
  const matchFacts = (matches: Awaited<ReturnType<typeof snapshot>>['matches']) =>
    matches.map(({ id, revision, status, outcome, winnerId, score1, score2 }) => ({
      id,
      revision,
      status,
      outcome,
      winnerId,
      score1,
      score2,
    }));
  const saveBracketPdf = async (filename: string) => {
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('.bracket-backup-toolbar')).toBeHidden();
    const pdf = await page.pdf({ format: 'A4', preferCSSPageSize: true });
    await writeFile(testInfo.outputPath(filename), pdf);
    expect(pdf.toString('latin1').match(/\/Type \/Page\b/g)).toHaveLength(1);
    await page.emulateMedia({ media: 'screen' });
  };
  const before = (await snapshot()).matches;
  expect(before.some((match) => match.outcome === 'bye')).toBe(true);
  const email = 'rehearsal-player@smashclub.dev';
  const organiser = await page.request.post('/api/auth/sign-in/email', {
    data: { email, password: 'devpassword123' },
  });
  expect(organiser.ok()).toBe(true);
  const unassigned = await page.request.get('/api/trpc/eventOps.overview', {
    params: { input: JSON.stringify({ planId }) },
  });
  expect(unassigned.status()).toBe(403);
  await rpc(request, 'eventOps.assignTo', { planId, email }, true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/operate/${planId}?view=draw`);
  const draw = page.getByRole('region', { name: 'Tournament draw', exact: true });
  await expect(draw.locator('.event-bracket-match')).toHaveCount(before.length);
  await expect(draw).toContainText('Quarter-final');
  const print = draw.getByRole('button', { name: 'Print bracket backup sheets', exact: true });
  const preview = page.getByRole('dialog', { name: 'Print bracket backup sheets' });
  for (const theme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveCSS('color-scheme', theme);
    await print.press('Enter');
    const paper = preview.locator('.bracket-backup-page');
    await expect(paper).toHaveCount(1);
    await expect(paper).toContainText('Bye');
    await expect(paper).toContainText('service returns');
    await expect(paper).toContainText('____');
    await expect(paper.locator('tbody tr').first().getByRole('cell').first()).toHaveText(
      'Quarter-final 1',
    );
    if (theme === 'dark') await page.context().setOffline(true);
    try {
      await saveBracketPdf(`native-draw-backup-${theme}.pdf`);
    } finally {
      await page.context().setOffline(false);
    }
    await preview.getByRole('button', { name: 'Close preview', exact: true }).click();
    await expect(print).toBeFocused();
    await expect(page.locator('body')).not.toHaveClass(/printing-bracket-backups/);
  }
  expect(matchFacts((await snapshot()).matches)).toEqual(matchFacts(before));
  const forfeited = before.find((match) => match.status === 'ready')!;
  await rpc(
    request,
    'eventOps.reportScore',
    {
      matchId: forfeited.id,
      expectedRevision: forfeited.revision,
      requestId: crypto.randomUUID(),
      score1: 0,
      score2: 0,
      outcome: 'forfeit',
      winnerId: forfeited.player2Id,
    },
    true,
  );
  for (let turn = 0; turn < 8; turn++) {
    const ready = (await snapshot()).matches.filter((match) => match.status === 'ready');
    if (!ready.length) break;
    for (const match of ready)
      await rpc(
        request,
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
  expect((await snapshot()).matches.every((match) => match.status === 'complete')).toBe(true);
  await rpc(
    request,
    'eventOps.live.command',
    { planId, requestId: crypto.randomUUID(), command: { kind: 'finalize' } },
    true,
  );
  const finalized = await snapshot();
  expect(finalized.plan.status).toBe('complete');
  await page.reload();
  await expect(draw).toContainText('Winner ·');
  await expect(page.locator('.native-result-correction')).toContainText(
    'Result revision 1 published.',
  );
  await expect(
    page.getByRole('button', { name: 'Finalize native results', exact: true }),
  ).toHaveCount(0);
  expect(
    (
      await new AxeBuilder({ page })
        .include('.ops-page')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({
    path: testInfo.outputPath('completed-to-draw-phone.png'),
    fullPage: true,
  });
  const printRecord = draw.getByRole('button', { name: 'Print draw record', exact: true });
  await expect(printRecord).toBeVisible();
  const record = page.getByRole('dialog', { name: 'Print draw record' });
  for (const theme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveCSS('color-scheme', theme);
    await printRecord.press('Enter');
    const paper = record.locator('.bracket-backup-page');
    await expect(paper).toHaveCount(1);
    await expect(paper).toContainText('Published draw record · Result revision 1');
    await expect(paper.locator('header')).toContainText(name);
    await expect(paper.locator('footer')).toContainText('Captured');
    await expect(
      paper.getByRole('columnheader', { name: 'Recorded result / winner' }),
    ).toBeVisible();
    await expect(paper).not.toContainText(/____|service returns|reconcile|Paper backup/i);
    await expect(record).not.toContainText(/attendance changes|fill qualifiers/i);
    for (const [outcome, result] of [
      ['bye', 'Bye'],
      ['forfeit', 'Forfeit'],
      ['played', '2–0'],
    ] as const) {
      const match = finalized.matches.find((item) => item.outcome === outcome)!;
      const winner = match.winnerId === match.player1Id ? match.player1Name : match.player2Name;
      const row = paper.getByRole('row').filter({
        has: page.getByRole('cell', { name: match.label, exact: true }),
      });
      const resultCell = row.getByRole('cell').last();
      await expect(resultCell.getByText(result, { exact: true })).toBeVisible();
      await expect(resultCell.getByText(`Winner: ${winner}`, { exact: true })).toBeVisible();
    }
    await saveBracketPdf(`completed-native-draw-record-${theme}.pdf`);
    await page.keyboard.press('Escape');
    await expect(printRecord).toBeFocused();
  }
  expect(matchFacts((await snapshot()).matches)).toEqual(matchFacts(finalized.matches));
});
