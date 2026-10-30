import { expect, test, type APIRequestContext } from '@playwright/test';
import { chooseOption } from '../test-support/controls';

type Match = {
  id: string;
  label: string;
  status: string;
  started: boolean;
  revision: number;
  stage: string;
  division: string;
  poolIndex: number | null;
  stationId: string | null;
  player1Id: string;
  player2Id: string;
  score1: number | null;
  score2: number | null;
  winnerId: string | null;
};
type Snapshot = {
  matches: Match[];
  stations: { id: string; name: string }[];
  stationQueues: { stationId: string; nextMatchId: string | null }[];
};
type LiveOverview = {
  audit: { kind: string; command: { matchId?: string } }[];
  reports: { matchId: string; status: string; isDispute: boolean }[];
};
async function signIn(request: APIRequestContext, email: string) {
  const response = await request.post('/api/auth/sign-in/email', {
    data: { email, password: 'devpassword123' },
  });
  expect(response.ok(), await response.text()).toBe(true);
}
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
async function freshSelfRunningEvent(request: APIRequestContext, autoAcceptScores: boolean) {
  const plans = await query<{ id: string; name: string }[]>(request, 'admin.eventPlanner.plans');
  const source = plans.find((plan) => plan.name === 'Nemesis · Rehearsal Night')!;
  const roster = await query<{
    entries: { playerId: string; playerName: string; companyId: string | null }[];
  }>(request, 'admin.eventPlanner.plan', { planId: source.id });
  const { planId } = await mutate<{ planId: string }>(request, 'admin.eventPlanner.createPlan', {
    name: `Report without Start ${crypto.randomUUID()}`,
    bracketMode: 'native',
    eventDate: new Date().toISOString(),
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
  await mutate(request, 'eventOps.settings', {
    planId,
    published: true,
    playerReports: true,
    scoreReportingMode: 'to_review',
  });
  for (const name of ['Pool setup', 'Main stage'])
    await mutate(request, 'eventOps.saveStation', { planId, name });
  const before = await query<Snapshot>(request, 'eventOps.snapshot', { planId });
  const station = before.stations.find((item) => item.name === 'Pool setup')!;
  await mutate(request, 'eventOps.configurePool', {
    planId,
    division: 'upper',
    poolIndex: 0,
    active: true,
    selfRun: true,
    autoAcceptScores,
    stationIds: [station.id],
    expectedRevision: 0,
  });
  await mutate(request, 'eventOps.guests.configure', {
    planId,
    enabled: true,
    showOnOverlay: false,
  });
  const invitation = await mutate<{ token: string }>(request, 'eventOps.guests.invitation', {
    planId,
  });
  const snapshot = await query<Snapshot>(request, 'eventOps.snapshot', { planId });
  const next = snapshot.stationQueues.find((queue) => queue.stationId === station.id)!.nextMatchId;
  const target = snapshot.matches.find(
    (match) => match.division === 'upper' && match.poolIndex === 0 && match.id !== next,
  )!;
  expect(target).toMatchObject({ status: 'ready', started: false, stationId: null });
  return { planId, target, snapshot, token: invitation.token };
}

for (const actor of ['guest', 'signed-in'] as const)
  for (const automatic of [true, false])
    test(`${actor} reports an out-of-order self-running match without Start (${automatic ? 'immediate' : 'TO review'})`, async ({
      page,
      browser,
      baseURL,
    }, testInfo) => {
      await signIn(page.request, 'admin@smashclub.dev');
      const { planId, target, snapshot, token } = await freshSelfRunningEvent(
        page.request,
        automatic,
      );
      const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
      const corroborator = await browser.newContext({ baseURL });
      try {
        if (actor === 'signed-in') await signIn(context.request, 'player@smashclub.dev');
        const reporting = await context.newPage();
        await reporting.goto(
          actor === 'guest'
            ? `/guest/${planId}#token=${encodeURIComponent(token)}`
            : `/play/${planId}`,
        );
        await chooseOption(reporting.getByLabel('Show matches for'), target.player1Id);
        const card = reporting.locator('article.ops-match').filter({ hasText: target.label });
        const submit = card.getByRole('button', {
          name: automatic ? 'Confirm result' : /^Submit score for (TO )?approval$/,
          exact: true,
        });
        await expect(card.getByRole('spinbutton')).toHaveCount(2);
        await expect(submit).toBeDisabled();
        await card.getByRole('spinbutton').nth(0).fill('2');
        await card.getByRole('spinbutton').nth(1).fill('0');
        await expect(submit).toBeEnabled();

        // A different match can be dispatched while this result form is open.
        // Its scheduling revision must not invalidate the unchanged pairing.
        const lower = snapshot.matches.find((match) => match.division === 'lower')!;
        const main = snapshot.stations.find((station) => station.name === 'Main stage')!;
        await mutate(page.request, 'eventOps.updateMatch', {
          matchId: lower.id,
          expectedRevision: lower.revision,
          status: 'playing',
          stationId: main.id,
        });
        await expect(submit).toBeEnabled();
        await expect(card.getByRole('spinbutton').nth(0)).toHaveValue('2');
        await submit.click();
        await expect(card).toContainText(
          automatic
            ? /Confirmed(?: result)?: 2 – 0/
            : actor === 'guest'
              ? 'Thanks! A TO will review your score.'
              : 'Score submitted for TO approval.',
        );
        let after = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
        expect(after.matches.find((match) => match.id === target.id)).toMatchObject(
          automatic
            ? {
                status: 'complete',
                started: false,
                stationId: null,
                score1: 2,
                score2: 0,
                winnerId: target.player1Id,
              }
            : {
                status: 'ready',
                started: false,
                stationId: null,
                score1: null,
                score2: null,
                winnerId: null,
              },
        );
        expect(after.matches.find((match) => match.id === lower.id)).toMatchObject({
          status: 'playing',
          stationId: main.id,
        });
        const live = await query<LiveOverview>(page.request, 'eventOps.live.overview', { planId });
        expect(live.reports.filter((report) => report.matchId === target.id)).toMatchObject([
          { status: automatic ? 'approved' : 'pending', isDispute: false },
        ]);
        expect(
          live.audit.filter(
            (entry) => entry.kind === 'dispatch' && entry.command.matchId === target.id,
          ),
        ).toHaveLength(0);

        if (automatic) {
          if (actor === 'guest') await signIn(corroborator.request, 'player@smashclub.dev');
          const other = await corroborator.newPage();
          await other.goto(
            actor === 'guest'
              ? `/play/${planId}`
              : `/guest/${planId}#token=${encodeURIComponent(token)}`,
          );
          await chooseOption(other.getByLabel('Show matches for'), target.player1Id);
          const recorded = other.locator('article.ops-match').filter({ hasText: target.label });
          await recorded
            .getByRole('button', { name: 'Confirm recorded score', exact: true })
            .click();
          await expect(recorded).toContainText('your score agrees');
          await recorded
            .getByRole('button', { name: 'Report a different score', exact: true })
            .click();
          await recorded.getByRole('spinbutton').nth(0).fill('0');
          await recorded.getByRole('spinbutton').nth(1).fill('2');
          await recorded
            .getByRole('button', { name: 'Send different score to TOs', exact: true })
            .click();
          await expect(recorded).toContainText('awaiting TO review');
          after = await query<Snapshot>(page.request, 'eventOps.snapshot', { planId });
          expect(after.matches.find((match) => match.id === target.id)).toMatchObject({
            score1: 2,
            score2: 0,
            winnerId: target.player1Id,
          });
          const disputed = await query<LiveOverview>(page.request, 'eventOps.live.overview', {
            planId,
          });
          expect(
            disputed.reports
              .filter((report) => report.matchId === target.id)
              .map((report) => [report.status, report.isDispute]),
          ).toEqual([
            ['approved', false],
            ['approved', false],
            ['pending', true],
          ]);
        }
        await reporting.evaluate(() => scrollTo(0, 0));
        await reporting.screenshot({
          path: testInfo.outputPath('report-without-start-phone.png'),
          fullPage: true,
        });
        expect(
          await reporting.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        ).toBe(true);
      } finally {
        await context.close();
        await corroborator.close();
      }
    });
