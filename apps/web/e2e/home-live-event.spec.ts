import { expect, test, type APIRequestContext } from '@playwright/test';
import { chooseOption } from '../test-support/controls';

async function query<T>(request: APIRequestContext, procedure: string, input?: object): Promise<T> {
  const response = await request.get(`/api/trpc/${procedure}`, {
    params: input ? { input: JSON.stringify(input) } : {},
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

test('home discovers open events, offers every format and keeps guest access on desktop and phone', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(180_000);
  const signedIn = await page.request.post('/api/auth/sign-in/email', {
    data: { email: 'admin@smashclub.dev', password: 'devpassword123' },
  });
  expect(signedIn.ok()).toBe(true);
  const plans = await query<{ id: string; name: string }[]>(
    page.request,
    'admin.eventPlanner.plans',
  );
  const source = plans.find((plan) => plan.name === 'Nemesis · Rehearsal Night')!;
  const roster = await query<{
    entries: { playerId: string; playerName: string; companyId: string | null }[];
  }>(page.request, 'admin.eventPlanner.plan', { planId: source.id });
  const original = await query<{ id: string; status: string }[]>(
    page.request,
    'eventOps.publicEvents',
  );
  const hidden = original.filter((event) => event.status === 'underway');
  const created: string[] = [];
  const closed = new Set<string>();
  const anonymous = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  try {
    for (const event of hidden)
      await mutate(page.request, 'eventOps.settings', {
        planId: event.id,
        published: false,
        playerReports: true,
      });
    async function create(
      name: string,
      competitionFormat = 'singles',
      eventDate = new Date(Date.now() - 60_000).toISOString(),
    ) {
      const doubles = competitionFormat === 'doubles';
      const result = await mutate<{ planId: string }>(
        page.request,
        'admin.eventPlanner.createPlan',
        {
          name,
          bracketMode: 'native',
          competitionFormat,
          structure: doubles ? 'round_robin' : 'dual_division',
          eventDate,
          upperTargetSize: doubles ? null : 4,
          rows: doubles
            ? []
            : roster.entries.slice(0, 8).map((entry, index) => ({
                lineNumber: index + 1,
                rawInput: entry.playerName,
                cleanedName: entry.playerName,
                playerId: entry.playerId,
                companyId: entry.companyId ?? null,
                resolutionMethod: 'manual',
                divisionPreference: 'auto',
              })),
        },
      );
      created.push(result.planId);
      if (doubles)
        for (let index = 0; index < 4; index++)
          await mutate(page.request, 'admin.eventPlanner.addDoublesPair', {
            ...result,
            playerId: roster.entries[index * 2]!.playerId,
            partnerPlayerId: roster.entries[index * 2 + 1]!.playerId,
            teamName: `Team ${index + 1}`,
          });
      return result;
    }
    async function prepare(plan: { planId: string }, lock: boolean) {
      for (const procedure of [
        'admin.eventPlanner.freezeRoster',
        'admin.eventPlanner.generatePools',
        'eventOps.prepare',
      ])
        await mutate(page.request, procedure, plan);
      if (lock) await mutate(page.request, 'eventOps.softLockPools', { ...plan, confirm: true });
    }
    async function publish(plan: { planId: string }, published = true) {
      await mutate(page.request, 'eventOps.settings', { ...plan, published, playerReports: true });
    }
    const stamp = Date.now();
    const singlesName = `Home singles ${stamp}`;
    const doublesName = `Home doubles ${stamp}`;
    const singles = await create(singlesName);
    await publish(singles); // A published draft is still preparation.
    const future = await create(
      `Tomorrow ${stamp}`,
      'singles',
      new Date(Date.now() + 86_400_000).toISOString(),
    );
    await prepare(future, true);
    await publish(future);
    const old = await create(
      `Previous night ${stamp}`,
      'singles',
      new Date(Date.now() - 2 * 86_400_000).toISOString(),
    );
    await prepare(old, true);
    await publish(old);
    const visitor = await anonymous.newPage();
    await visitor.goto('/');
    const entry = visitor.getByRole('region', { name: 'Currently live' });
    const open = entry.getByRole('link', { name: 'Open live tournament', exact: true });
    await expect(entry).toContainText('No tournament is live right now.');
    await expect(open).toHaveCount(0);
    await expect(visitor.locator('.board-row').first()).toBeVisible();
    await prepare(singles, false);
    await expect(open).toHaveCount(0); // Published pools without an open draw are not live.
    await mutate(page.request, 'eventOps.softLockPools', { ...singles, confirm: true });
    await expect(entry.getByRole('heading', { name: singlesName, exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(open).toHaveCount(1);
    await visitor.screenshot({
      path: testInfo.outputPath('home-live-desktop.png'),
    });
    await open.click();
    await expect(visitor).toHaveURL(new RegExp(`/play/${singles.planId}$`));
    await expect(visitor.getByRole('heading', { name: singlesName, exact: true })).toBeVisible();
    await expect(visitor.getByRole('heading', { name: 'Scan in to report a score' })).toBeVisible();
    const doubles = await create(doublesName, 'doubles');
    await prepare(doubles, true);
    await publish(doubles);
    await visitor.setViewportSize({ width: 390, height: 844 });
    await visitor.goto('/');
    await expect(entry).toContainText('2 live tournaments · choose yours.');
    await expect(open).toHaveCount(2);
    await expect(entry).toContainText('Singles');
    await expect(entry).toContainText('Doubles');
    await expect(entry).not.toContainText(`Tomorrow ${stamp}`);
    await expect(entry).not.toContainText(`Previous night ${stamp}`);
    expect(
      await visitor.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    ).toBe(true);
    await visitor.screenshot({
      path: testInfo.outputPath('home-live-multiple-phone.png'),
    });
    await entry.locator('li').filter({ hasText: doublesName }).getByRole('link').click();
    await expect(visitor).toHaveURL(new RegExp(`/play/${doubles.planId}$`));
    await expect(visitor.getByRole('heading', { name: doublesName, exact: true })).toBeVisible();
    await mutate(page.request, 'eventOps.guests.configure', {
      ...singles,
      enabled: true,
      showOnOverlay: false,
    });
    const invitation = await mutate<{ token: string }>(
      page.request,
      'eventOps.guests.invitation',
      singles,
    );
    await visitor.goto(`/guest/${singles.planId}#token=${encodeURIComponent(invitation.token)}`);
    await expect(visitor.locator('.guest-pass-expiry')).toContainText('valid until revoked');
    await visitor.goto('/');
    await entry.locator('li').filter({ hasText: singlesName }).getByRole('link').click();
    await expect(visitor.locator('.guest-pass-expiry')).toContainText('valid until revoked');
    await chooseOption(visitor.getByLabel('Match view', { exact: true }), 'matches');
    await expect(visitor.locator('article.ops-match input[type="number"]').first()).toBeVisible();
    await visitor.goto('/');
    await mutate(page.request, 'eventOps.live.command', {
      ...doubles,
      requestId: crypto.randomUUID(),
      command: { kind: 'unlock' },
    });
    await expect(open).toHaveCount(1, { timeout: 20_000 });
    await expect(entry).not.toContainText(doublesName);
    await publish(singles, false);
    await expect(entry).toContainText('No tournament is live right now.', { timeout: 20_000 });
    await mutate(page.request, 'eventOps.live.command', {
      ...doubles,
      requestId: crypto.randomUUID(),
      command: { kind: 'relock' },
    });
    await expect(entry).toContainText(doublesName, { timeout: 20_000 });
    await mutate(page.request, 'eventOps.live.command', {
      ...doubles,
      requestId: crypto.randomUUID(),
      command: { kind: 'cancel', reason: 'Synthetic night finished' },
    });
    closed.add(doubles.planId);
    await expect(entry).toContainText('No tournament is live right now.', { timeout: 20_000 });
    await entry.getByRole('link', { name: 'All events →' }).click();
    await expect(
      visitor.getByRole('heading', { name: `Previous night ${stamp}`, exact: true }),
    ).toBeVisible();
  } finally {
    for (const planId of created)
      if (!closed.has(planId))
        await mutate(page.request, 'eventOps.settings', {
          planId,
          published: false,
          playerReports: true,
        });
    for (const event of hidden)
      await mutate(page.request, 'eventOps.settings', {
        planId: event.id,
        published: true,
        playerReports: true,
      });
    await anonymous.close();
  }
});
