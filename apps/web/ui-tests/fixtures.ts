import type { Page } from '@playwright/test';
import publicSnapshot from './fixtures/snapshot.json' with { type: 'json' };
import extra from './fixtures/overview-extra.json' with { type: 'json' };
import guestSettings from './fixtures/guest-settings.json' with { type: 'json' };

export const PLAN_ID = publicSnapshot.plan.id;
export const PLAYER_NAME = 'Alex with a long tournament alias';
export type FixtureOptions = {
  role?: 'admin' | 'player';
  idle?: boolean;
  failure?: boolean;
  bracket?: boolean;
  loading?: Promise<void>;
};

export async function mockEvent(page: Page, options: FixtureOptions = {}) {
  const snapshot = structuredClone(publicSnapshot);
  if (!options.bracket) {
    snapshot.nativeBrackets = [];
    snapshot.matches = snapshot.matches.filter((match) => !match.nativeBracketId);
  }
  if (options.idle) {
    snapshot.matches.forEach((match) => {
      if (match.status === 'playing') match.status = 'ready';
    });
    snapshot.stations.forEach((station) => {
      station.currentMatchId = null;
      station.status = 'free';
    });
    snapshot.stationQueues.forEach((queue) => {
      queue.currentMatchId = null;
    });
  }
  const overview = { ...snapshot, ...structuredClone(extra) };
  const user = {
    id: 'example-user',
    name: 'Alex',
    email: 'alex@example.test',
    role: options.role ?? 'player',
    emailVerified: true,
    image: null,
    createdAt: '2026-10-04T00:00:00Z',
    updatedAt: '2026-10-04T00:00:00Z',
  };
  const submissions: Record<string, unknown>[] = [];
  const starts: Record<string, unknown>[] = [];
  const unexpected: string[] = [];
  const responses: Record<string, unknown> = {
    'me.whoami': user,
    'me.claims': [],
    'eventOps.snapshot': snapshot,
    'eventOps.overview': overview,
    'eventOps.myReports': [],
    'eventOps.guests.settings': guestSettings,
    'eventOps.guests.overlayInvitation': null,
    'eventOps.attendeeRoster': { attendees: [], companies: [] },
    'admin.eventPlanner.plans': [],
    'public.searchPlayers': [],
    'admin.players': [],
    'admin.companies': [],
    'admin.claims': [],
  };
  await page.clock.setFixedTime(new Date('2026-10-04T00:00:00Z'));
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/get-session') {
      await route.fulfill({
        json: options.role
          ? {
              user,
              session: {
                id: 'fixture-session',
                userId: user.id,
                expiresAt: '2027-01-01T00:00:00Z',
                token: 'local-fixture',
              },
            }
          : null,
      });
      return;
    }
    if (url.pathname === '/api/live') {
      await route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
      return;
    }
    if (options.loading && url.pathname.includes('eventOps.snapshot')) await options.loading;
    const procedures = decodeURIComponent(url.pathname.replace('/api/trpc/', '')).split(',');
    const result = procedures.map((procedure, index) => {
      if (procedure === 'eventOps.startPoolMatch') {
        const body = JSON.parse(route.request().postData() ?? '{}');
        const input = url.searchParams.get('batch') ? body[index] : body;
        starts.push(input);
        const match = snapshot.matches.find((item) => item.id === input.matchId)!;
        Object.assign(match, {
          status: 'playing',
          stationId: input.stationId,
          started: true,
          resourceRevision: ++snapshot.settings.resourceRevision,
        });
        return { result: { data: match } };
      }
      if (procedure === 'eventOps.reportScore') {
        const body = JSON.parse(route.request().postData() ?? '{}');
        submissions.push(url.searchParams.get('batch') ? body[index] : body);
        return { result: { data: { status: 'pending', isDispute: false } } };
      }
      if (options.failure && procedure === 'eventOps.snapshot')
        return {
          error: {
            message: 'Connection interrupted',
            code: -32603,
            data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
          },
        };
      if (!(procedure in responses)) unexpected.push(procedure);
      return { result: { data: procedure in responses ? responses[procedure] : [] } };
    });
    await route.fulfill({ json: url.searchParams.get('batch') ? result : result[0] });
  });
  return { snapshot, overview, submissions, starts, unexpected };
}

export async function ready(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    // Let inherited colors settle before axe reads contrast, as well as before capture.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
}
