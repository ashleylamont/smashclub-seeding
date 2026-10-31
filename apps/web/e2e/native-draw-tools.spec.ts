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

test('a phone TO reads and prints a real native draw before and after finalization without changing results', async ({
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
  const name = 'TO draw and print rehearsal';
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
  const snapshot = () =>
    rpc<Awaited<ReturnType<typeof trpc.eventOps.snapshot.query>>>(
      page.request,
      'eventOps.snapshot',
      { planId },
    );
  const before = (await snapshot()).matches;
  expect(before.some((match) => match.outcome === 'bye')).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/operate/${planId}?view=draw`);
  const draw = page.getByRole('region', { name: 'Tournament draw', exact: true });
  await expect(draw.locator('.event-bracket-match')).toHaveCount(before.length);
  await expect(draw).toContainText('Quarter-final');
  const print = draw.getByRole('button', { name: 'Print bracket backup sheets', exact: true });
  await print.focus();
  await page.keyboard.press('Enter');
  const preview = page.getByRole('dialog', { name: 'Print bracket backup sheets' });
  await expect(preview.locator('.bracket-backup-page')).toHaveCount(1);
  await expect(preview).toContainText('Bye');
  await page.emulateMedia({ media: 'print' });
  const pdf = await page.pdf({ format: 'A4', preferCSSPageSize: true });
  await writeFile(testInfo.outputPath('native-draw-backup.pdf'), pdf);
  expect(pdf.toString('latin1').match(/\/Type \/Page\b/g)).toHaveLength(1);
  await page.emulateMedia({ media: 'screen' });
  await preview.getByRole('button', { name: 'Close preview', exact: true }).click();
  await expect(print).toBeFocused();
  await expect(page.locator('body')).not.toHaveClass(/printing-bracket-backups/);
  expect(
    (await snapshot()).matches.map((m) => [m.id, m.revision, m.status, m.score1, m.score2]),
  ).toEqual(before.map((m) => [m.id, m.revision, m.status, m.score1, m.score2]));
  for (let turn = 0; turn < 8; turn++) {
    const ready = (await snapshot()).matches.filter((match) => match.status === 'ready');
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
  expect((await snapshot()).matches.every((match) => match.status === 'complete')).toBe(true);
  await rpc(
    page.request,
    'eventOps.live.command',
    { planId, requestId: crypto.randomUUID(), command: { kind: 'finalize' } },
    true,
  );
  await page.reload();
  await expect(draw).toContainText('Winner ·');
  await expect(
    page.getByRole('button', { name: 'Finalize native results', exact: true }),
  ).toBeDisabled();
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
  await print.click();
  await expect(preview).toContainText('Online: 2–0');
  await expect(preview.locator('.bracket-backup-page')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(print).toBeFocused();
});
