import { expect, test } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { mockEvent, PLAN_ID, ready } from './fixtures';
import { chooseOption } from '../test-support/controls';

for (const alias of ['live', 'guest'])
  test(`${alias} printed link preserves event, pool, player and station in the canonical hub`, async ({
    page,
  }) => {
    const fixture = await mockEvent(page);
    const match = fixture.snapshot.matches.find((item) => item.status === 'playing')!;
    const params = new URLSearchParams({
      pool: `${match.division}:${match.poolIndex}`,
      player: match.player1Id!,
      station: match.stationId!,
    });
    await page.goto(`/${alias}/${PLAN_ID}?${params}`);
    await expect(page).toHaveURL(new RegExp(`/play/${PLAN_ID}\\?`));
    await expect(page.getByLabel('Show matches for')).toHaveAttribute(
      'data-value',
      match.player1Id!,
    );
    await expect(page.getByLabel('Your pool')).toHaveAttribute(
      'data-value',
      `${match.division}:${match.poolIndex}`,
    );
    await page.getByRole('button', { name: /Match filters/ }).click();
    await expect(page.getByRole('combobox', { name: 'Station', exact: true })).toHaveAttribute(
      'data-value',
      match.stationId!,
    );
    await expect(page.getByRole('link', { name: 'Smash Club', exact: true })).toHaveAttribute(
      'href',
      '/',
    );
    for (const [label, id] of [
      ['Pools', 'event-pools'],
      ['Brackets', 'event-brackets'],
      ['Results', 'event-results'],
      ['Find my matches', 'my-matches'],
    ]) {
      await page.getByRole('link', { name: label, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`#${id}$`));
      await expect(page.locator(`#${id}`)).toBeInViewport();
    }
    await expect(page.getByRole('heading', { name: 'Pool progress & standings' })).toBeVisible();
    await expect(page.locator('#event-brackets')).toContainText('Brackets will appear here');
    await expect(page.locator('article.ops-match input')).toHaveCount(0);
    expect(fixture.unexpected).toEqual([]);
  });

test('phone hub retains score drafts through section navigation, offline recovery and scheduling refresh', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await mockEvent(page, { role: 'player' });
  await page.goto(`/play/${PLAN_ID}`);
  const match = fixture.snapshot.matches.find((item) => item.status === 'playing')!;
  const card = page.locator('article.ops-match').filter({ hasText: match.label });
  await card.getByRole('spinbutton').nth(0).fill('2');
  for (const section of ['Pools', 'Brackets', 'Results', 'What next', 'Find my matches']) {
    await page.getByRole('link', { name: section, exact: true }).click();
    await expect(card.getByRole('spinbutton').nth(0)).toHaveValue('2');
  }
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(page.getByRole('alert')).toContainText('Live updates interrupted');
  await expect(card.getByRole('button', { name: /Submit score/ })).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(card.getByRole('spinbutton').nth(0)).toHaveValue('2');
  match.revision++;
  await expect(card).toContainText('Match details changed');
  await expect(card.getByRole('spinbutton').nth(0)).toHaveValue('2');
  await expect(card.getByRole('button', { name: /Submit score/ })).toBeDisabled();
  await card.getByRole('button', { name: 'Reload match' }).click();
  await expect(card.getByRole('spinbutton').nth(0)).toHaveValue('0');
  await ready(page);
  expect(
    (
      await new AxeBuilder({ page })
        .include('.player-event-hub')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('unified-player-hub-phone.png'),
    fullPage: true,
  });
  expect(fixture.unexpected).toEqual([]);
});

test('signed-in attendee redeems old QR into guest adapter when account reporting is disabled', async ({
  page,
}, testInfo) => {
  const fixture = await mockEvent(page, { role: 'player' });
  fixture.snapshot.settings.playerReports = false;
  const invitation = 'fixture-invitation-secret';
  const sessionToken = 'fixture-guest-session-secret'.repeat(2);
  fixture.responses['eventOps.guests.redeem'] = { sessionToken, expiresAt: null };
  fixture.responses['eventOps.guests.matches'] = { ...fixture.snapshot, reports: [] };
  fixture.responses['eventOps.guests.submit'] = { status: 'pending', isDispute: false };
  const urls: string[] = [];
  page.on('request', (request) => urls.push(request.url()));
  await page.goto(`/guest/${PLAN_ID}?pool=upper%3A0#token=${invitation}`);
  await expect(page).toHaveURL(new RegExp(`/play/${PLAN_ID}\\?pool=upper%3A0$`));
  await expect(
    page.getByText('Reporting with your venue guest pass.', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('.guest-pass-expiry')).toContainText('valid until revoked');
  const card = page.locator('article.ops-match').first();
  await card.getByRole('spinbutton').nth(0).fill('2');
  await card.getByRole('button', { name: /Submit score/ }).click();
  await expect(card).toContainText('Thanks! A TO will review your score.');
  await page.getByRole('link', { name: 'Pools', exact: true }).click();
  await page.reload();
  await expect(page.locator('.guest-pass-expiry')).toContainText('valid until revoked');
  expect(urls.some((url) => url.includes(invitation) || url.includes(sessionToken))).toBe(false);
  expect(fixture.unexpected).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath('unified-player-hub-desktop.png'),
    fullPage: true,
  });
});

test('retry keeps the same report identity and scores after a transport failure', async ({
  page,
}) => {
  const fixture = await mockEvent(page, { role: 'player' });
  const requests: Record<string, unknown>[] = [];
  let fail = true;
  await page.route('**/api/trpc/eventOps.reportScore*', async (route) => {
    const body = JSON.parse(route.request().postData()!);
    requests.push(new URL(route.request().url()).searchParams.has('batch') ? body[0] : body);
    if (!fail) return route.fallback();
    fail = false;
    const error = {
      error: {
        message: 'Temporary reporting failure. Try again.',
        code: -32603,
        data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
      },
    };
    await route.fulfill({
      status: 500,
      json: new URL(route.request().url()).searchParams.has('batch') ? [error] : error,
    });
  });
  await page.goto(`/play/${PLAN_ID}`);
  const card = page.locator('article.ops-match').first();
  await card.getByRole('spinbutton').nth(0).fill('2');
  await card.getByRole('button', { name: /Submit score/ }).click();
  await expect(card.getByRole('alert')).toContainText('Temporary reporting failure');
  await expect(card.getByRole('spinbutton').nth(0)).toHaveValue('2');
  await card.getByRole('button', { name: /Submit score/ }).click();
  await expect(card).toContainText('Score submitted for TO approval');
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(fixture.unexpected).toEqual([]);
});

test('cold results links scroll after the public snapshot mounts', async ({ page }) => {
  let release!: () => void;
  const fixture = await mockEvent(page, {
    loading: new Promise<void>((resolve) => {
      release = resolve;
    }),
  });
  await page.goto(`/play/${PLAN_ID}#event-results`);
  await expect(page.getByRole('status')).toContainText('Loading your event');
  release();
  await expect(page.locator('#event-results')).toBeInViewport();
  await expect(page.getByRole('heading', { name: 'Recorded results' })).toBeInViewport();
  expect(fixture.unexpected).toEqual([]);
});

test('account expiry and replacement hide private reports and feedback while retaining score drafts', async ({
  page,
}) => {
  const fixture = await mockEvent(page, { role: 'player' });
  fixture.snapshot.settings.scoreReportingMode = 'approve_unless_disputed';
  const open = fixture.snapshot.matches.filter((match) => match.status === 'ready');
  const rejected = open[0]!;
  const submitted = open[1]!;
  const draft = open[2]!;
  const completed = fixture.snapshot.matches.find((match) => match.status === 'complete')!;
  fixture.responses['eventOps.myReports'] = [
    {
      id: 'private-report-A',
      matchId: rejected.id,
      status: 'rejected',
      score1: 2,
      score2: 1,
      isDispute: false,
    },
  ];
  fixture.responses['me.claims'] = [{ status: 'approved', playerName: 'Private profile A' }];
  let account: string | null = 'account-A';
  await page.route('**/api/auth/get-session', async (route) =>
    route.fulfill({
      json: account
        ? {
            user: {
              id: account,
              name: account,
              email: `${account}@example.test`,
              emailVerified: true,
              image: null,
              createdAt: '2026-10-04T00:00:00Z',
              updatedAt: '2026-10-04T00:00:00Z',
            },
            session: {
              id: account,
              userId: account,
              expiresAt: '2027-01-01T00:00:00Z',
              token: 'fixture-auth',
            },
          }
        : null,
    }),
  );
  await page.goto(`/play/${PLAN_ID}`);
  await chooseOption(page.getByLabel('Match view', { exact: true }), 'matches');
  const rejectedCard = page.locator('article.ops-match').filter({ hasText: rejected.label });
  const submittedCard = page.locator('article.ops-match').filter({ hasText: submitted.label });
  const draftCard = page.locator('article.ops-match').filter({ hasText: draft.label });
  const completedCard = page.locator('article.ops-match').filter({ hasText: completed.label });
  await expect(page.getByText('Private profile A', { exact: true })).toBeVisible();
  await expect(rejectedCard).toContainText('Your report: 2 – 1');
  await submittedCard.getByRole('spinbutton').nth(0).fill('2');
  await submittedCard.getByRole('button', { name: 'Confirm result', exact: true }).click();
  await expect(submittedCard).toContainText('Score submitted for TO approval');
  await draftCard.getByRole('spinbutton').nth(0).fill('3');
  await completedCard.getByRole('button', { name: 'Confirm recorded score', exact: true }).click();
  await expect(completedCard).toContainText('your score agrees');
  account = null;
  await page.clock.setFixedTime(new Date('2026-10-04T00:00:10Z'));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByText('Private profile A', { exact: true })).toHaveCount(0);
  await expect(rejectedCard.getByText('Your report:', { exact: false })).toHaveCount(0);
  await expect(completedCard.getByText('your score agrees', { exact: false })).toHaveCount(0);
  account = 'account-B';
  fixture.responses['eventOps.myReports'] = [];
  fixture.responses['me.claims'] = [];
  await page.clock.setFixedTime(new Date('2026-10-04T00:00:20Z'));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByRole('link', { name: 'account-B', exact: true })).toBeVisible();
  await expect(submittedCard.getByRole('spinbutton').nth(0)).toHaveValue('2');
  await expect(draftCard.getByRole('spinbutton').nth(0)).toHaveValue('3');
  await expect(
    submittedCard.getByText('Score submitted for TO approval', { exact: false }),
  ).toHaveCount(0);
  await expect(rejectedCard.getByRole('spinbutton')).toHaveCount(2);
  await expect(page.getByText('Private profile A', { exact: true })).toHaveCount(0);
  await expect(completedCard.getByText('your score agrees', { exact: false })).toHaveCount(0);
  expect(fixture.unexpected).toEqual([]);
});

test('guest permission polling failure disables writes without switching to the signed-in account', async ({
  page,
}) => {
  const fixture = await mockEvent(page, { role: 'player' });
  fixture.responses['eventOps.guests.redeem'] = {
    sessionToken: 'saved-venue-pass'.repeat(3),
    expiresAt: null,
  };
  fixture.responses['eventOps.guests.matches'] = { ...fixture.snapshot, reports: [] };
  let interrupted = false;
  await page.route('**/api/trpc/eventOps.guests.matches*', async (route) => {
    if (!interrupted) return route.fallback();
    const error = {
      error: {
        message: 'Guest connection interrupted',
        code: -32603,
        data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
      },
    };
    await route.fulfill({
      status: 500,
      json: new URL(route.request().url()).searchParams.has('batch') ? [error] : error,
    });
  });
  await page.goto(`/play/${PLAN_ID}#token=venue-invitation`);
  await expect(
    page.getByText('Reporting with your venue guest pass.', { exact: true }),
  ).toBeVisible();
  const card = page.locator('article.ops-match').first();
  await card.getByRole('spinbutton').nth(0).fill('2');
  interrupted = true;
  await expect(page.getByText('Reporting connection interrupted.', { exact: false })).toBeVisible();
  await expect(card.getByRole('spinbutton')).toHaveCount(0);
  await expect(
    page.getByText('Reporting with your venue guest pass.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Reporting with your signed-in account.', { exact: true }),
  ).toHaveCount(0);
  interrupted = false;
  await expect(card.getByRole('spinbutton').nth(0)).toHaveValue('2');
  expect(fixture.unexpected).toEqual([]);
});

for (const durablePass of [false, true])
  test(`${durablePass ? 'durable guest pass' : 'anonymous viewer'} expires public announcements without another event update`, async ({
    page,
  }) => {
    const fixture = await mockEvent(page);
    Object.assign(fixture.snapshot, {
      announcements: [
        {
          id: 'timed-announcement',
          message: 'Timed venue announcement',
          expiresAt: '2026-10-04T00:00:30Z',
        },
      ],
    });
    if (durablePass) {
      const session = { sessionToken: 'durable-fixture-pass'.repeat(3), expiresAt: null };
      fixture.responses['eventOps.guests.matches'] = { ...fixture.snapshot, reports: [] };
      await page.addInitScript(
        ({ planId, session }) =>
          localStorage.setItem(`nemesis:guest:${planId}`, JSON.stringify(session)),
        { planId: PLAN_ID, session },
      );
    }
    await page.goto(`/play/${PLAN_ID}`);
    await expect(page.getByText('Timed venue announcement', { exact: true })).toBeVisible();
    if (durablePass)
      await expect(page.locator('.guest-pass-expiry')).toContainText('valid until revoked');
    await page.clock.setFixedTime(new Date('2026-10-04T00:01:00Z'));
    await expect(page.getByText('Timed venue announcement', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('complementary', { name: 'Announcements' })).toHaveCount(0);
    expect(fixture.unexpected).toEqual([]);
  });

for (const drawn of [false, true])
  test(`native ${drawn ? 'published' : 'pending'} brackets ignore legacy Challonge links`, async ({
    page,
  }) => {
    const fixture = await mockEvent(page, { bracket: drawn });
    Object.assign(fixture.snapshot, {
      brackets: [{ division: 'upper', stage: 'main', slug: 'stale-external-draw' }],
    });
    await page.goto(`/play/${PLAN_ID}`);
    if (drawn) {
      await expect(page.locator('.event-brackets')).toContainText('Semi-final A');
      await expect(page.locator('#event-brackets')).not.toContainText('Brackets will appear here');
    } else {
      await expect(page.locator('#event-brackets')).toContainText(
        'Brackets will appear here when the organisers publish the draw.',
      );
      await expect(page.locator('#event-brackets .event-bracket-match')).toHaveCount(0);
    }
    await expect(page.locator('a[href*="challonge.com"]')).toHaveCount(0);
    expect(fixture.unexpected).toEqual([]);
  });
