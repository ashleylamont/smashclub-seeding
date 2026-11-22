import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { chooseOption } from '../test-support/controls';
import { mockEvent, PLAN_ID, PLAYER_NAME, ready } from './fixtures';

for (const width of [390, 1440]) {
  for (const theme of ['dark', 'light'] as const) {
    test(`${theme} ${width}px same-tab score recovery waits for the current viewer and retries only on request`, async ({
      page,
      context,
    }, testInfo) => {
      test.setTimeout(60_000);
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      const guest = (width === 390) === (theme === 'dark');
      const fixture = await mockEvent(page, { role: guest ? undefined : 'player' });
      const match = fixture.snapshot.matches.find((row) => row.status === 'playing')!;
      const guestToken = 'score-recovery-fixture-guest-pass'.repeat(2);
      const guestView = {
        ...fixture.snapshot,
        reportingDraftOwnerId: '00000000-0000-4000-8000-000000000071',
        reports: [] as object[],
      };
      fixture.responses['eventOps.guests.redeem'] = { sessionToken: guestToken, expiresAt: null };
      fixture.responses['eventOps.guests.matches'] = guestView;
      const records = guest ? 'eventOps.guests.matches' : 'eventOps.myReports';
      let releaseVerification!: () => void;
      const verified = new Promise<void>((resolve) => {
        releaseVerification = resolve;
      });
      let holdRecords = false;
      await page.route(new RegExp(`/api/trpc/.*${records}`), async (route) => {
        if (holdRecords) await verified;
        await route.fallback();
      });
      const requests: Record<string, unknown>[] = [];
      const submitProcedure = guest ? 'eventOps.guests.submit' : 'eventOps.reportScore';
      await page.route(`**/api/trpc/${submitProcedure}*`, async (route) => {
        const batched = new URL(route.request().url()).searchParams.has('batch');
        const body = route.request().postDataJSON();
        const payload = batched ? body[0] : body;
        requests.push(payload);
        if (requests.length === 1) return route.abort('failed');
        const report = {
          id: 'accepted-draft',
          matchId: match.id,
          score1: 2,
          score2: 1,
          status: 'pending',
          isDispute: false,
        };
        if (guest) guestView.reports = [report];
        else fixture.responses['eventOps.myReports'] = [report];
        const response = { result: { data: report } };
        await route.fulfill({ json: batched ? [response] : response });
      });
      await page.goto(`/play/${PLAN_ID}${guest ? '#token=example-guest-invitation' : ''}`);
      const card = page.locator(`[data-player-match-id="${match.id}"]`);
      const scores = card.getByRole('spinbutton');
      const submit = card.getByRole('button', { name: 'Submit score for TO approval' });
      await scores.nth(0).fill('2');
      await scores.nth(1).fill('1');
      await card.getByRole('button', { name: 'Add characters (optional)' }).press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Characters played' });
      await chooseOption(dialog.getByRole('combobox').first(), 'fox');
      await page.keyboard.press('Escape');
      await expect(card.getByRole('button', { name: 'Edit characters (1)' })).toBeFocused();
      await submit.click();
      await expect(card.getByRole('alert')).toBeVisible();
      expect(requests).toHaveLength(1);

      const storedKeys = () =>
        page.evaluate(() =>
          Object.keys(sessionStorage).filter((key) => key.startsWith('nemesis:score-drafts:')),
        );
      await expect.poll(storedKeys).toHaveLength(1);
      await context.setOffline(true);
      await expect(
        page.getByText('Live updates interrupted. Scores shown may be out of date.'),
      ).toBeVisible();
      await expect.poll(storedKeys).toHaveLength(1);
      await context.setOffline(false);
      holdRecords = true;
      try {
        await page.reload();
        await expect(card).toBeVisible();
        await expect.poll(storedKeys).toHaveLength(1);
        await expect(card.getByRole('button', { name: 'Edit characters (1)' })).toHaveCount(0);
        expect(requests).toHaveLength(1);
      } finally {
        releaseVerification();
      }
      await expect(scores.nth(0)).toHaveValue('2');
      await expect(scores.nth(1)).toHaveValue('1');
      await expect(card.getByRole('button', { name: 'Edit characters (1)' })).toBeVisible();
      await expect(card).toContainText(PLAYER_NAME);
      expect(requests).toHaveLength(1);
      const stored = await page.evaluate(() =>
        Object.entries(sessionStorage).filter(([key]) => key.startsWith('nemesis:score-drafts:')),
      );
      expect(stored).toHaveLength(1);
      const serialized = JSON.stringify(stored);
      for (const privateValue of [
        guestToken,
        'example-guest-invitation',
        guestView.reportingDraftOwnerId,
        'alex@example.test',
        'example-user',
        'fixture-session',
        'local-fixture',
        PLAYER_NAME,
      ])
        expect(serialized).not.toContain(privateValue);
      await ready(page);
      await card.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(
        (
          await new AxeBuilder({ page })
            .include('.player-event-hub')
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath('same-tab-score-recovery.png') });

      await submit.click();
      await expect(card).toContainText('Your report: 2 – 1 · Awaiting TO approval');
      expect(requests).toHaveLength(2);
      expect(requests[1]).toEqual(requests[0]);
      await expect
        .poll(() =>
          page.evaluate(() =>
            Object.keys(sessionStorage).some((key) => key.startsWith('nemesis:score-drafts:')),
          ),
        )
        .toBe(false);
      expect(fixture.unexpected).toEqual([]);
    });
  }
}

test('a reloaded draft keeps its frozen revision, while a swapped pairing retires it', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const fixture = await mockEvent(page, { role: 'player' });
  const match = fixture.snapshot.matches.find((row) => row.status === 'playing')!;
  await page.goto(`/play/${PLAN_ID}`);
  const card = page.locator(`[data-player-match-id="${match.id}"]`);
  const scores = card.getByRole('spinbutton');
  const submit = card.getByRole('button', { name: 'Submit score for TO approval' });
  await scores.nth(0).fill('2');
  await scores.nth(1).fill('');
  await card.getByRole('button', { name: 'Add characters (optional)' }).click();
  await chooseOption(page.getByRole('dialog').getByRole('combobox').first(), 'fox');
  await page.keyboard.press('Escape');

  match.revision++;
  await page.reload();
  await expect(scores.nth(0)).toHaveValue('2');
  await expect(scores.nth(1)).toHaveValue('');
  await expect(submit).toBeDisabled();
  await card.getByRole('button', { name: 'Reload match' }).click();
  await expect(scores.nth(0)).toHaveValue('2');
  await expect(scores.nth(1)).toHaveValue('');
  await expect(card.getByRole('button', { name: 'Edit characters (1)' })).toBeVisible();

  Object.assign(match, {
    player1Id: match.player2Id,
    player2Id: match.player1Id,
    player1Name: match.player2Name,
    player2Name: match.player1Name,
    revision: match.revision + 1,
  });
  await page.reload();
  await expect(scores.nth(0)).toHaveValue('0');
  await expect(scores.nth(1)).toHaveValue('0');
  await expect(card.getByRole('button', { name: 'Add characters (optional)' })).toBeVisible();
  expect(fixture.submissions).toEqual([]);
});

test('a verified confirmation receipt retires its draft after an interrupted response', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const fixture = await mockEvent(page, { role: 'player' });
  fixture.snapshot.settings.scoreReportingMode = 'approve_unless_disputed';
  const match = fixture.snapshot.matches.find(
    (row) => row.status === 'complete' && row.outcome === 'played',
  )!;
  const requests: Record<string, unknown>[] = [];
  await page.route('**/api/trpc/eventOps.reportScore*', async (route) => {
    const body = route.request().postDataJSON();
    const batched = new URL(route.request().url()).searchParams.has('batch');
    requests.push(batched ? body[0] : body);
    await route.abort('failed');
  });
  await page.goto(`/play/${PLAN_ID}?match=${match.id}`);
  const card = page.locator(`[data-player-match-id="${match.id}"]`);
  await card.getByRole('button', { name: 'Add characters (optional)' }).click();
  await chooseOption(page.getByRole('dialog').getByRole('combobox').first(), 'fox');
  await page.keyboard.press('Escape');
  await card.getByRole('button', { name: 'Confirm recorded score' }).click();
  await expect(card.getByRole('alert')).toBeVisible();
  expect(requests).toHaveLength(1);
  fixture.responses['eventOps.myReports'] = [
    {
      ...requests[0],
      id: 'verified-confirmation',
      status: 'approved',
      isDispute: false,
    },
  ];
  await expect(card.getByText(/Your report:.*Confirmed result/)).toBeVisible();
  await expect(card.getByRole('alert')).toHaveCount(0);
  await page.reload();
  await expect(card.getByText(/Your report:.*Confirmed result/)).toBeVisible();
  await expect(card.getByRole('button', { name: 'Add characters (optional)' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Edit characters (1)' })).toHaveCount(0);
  expect(requests).toHaveLength(1);
});

test('a completed report starts clean if the event removes and restores its reporting policy', async ({
  page,
}) => {
  const fixture = await mockEvent(page, { role: 'player' });
  fixture.snapshot.settings.scoreReportingMode = 'approve_unless_disputed';
  const match = fixture.snapshot.matches.find(
    (row) => row.status === 'complete' && row.outcome === 'played',
  )!;
  await page.goto(`/play/${PLAN_ID}?match=${match.id}`);
  const card = page.locator(`[data-player-match-id="${match.id}"]`);
  const reportDifferent = card.getByRole('button', { name: 'Report a different score' });
  const scores = card.getByRole('spinbutton');
  const stored = () => page.evaluate(() => sessionStorage.getItem('nemesis:score-drafts:v1'));

  await reportDifferent.click();
  await scores.first().fill('4');
  await card.getByRole('button', { name: 'Add characters (optional)' }).click();
  await chooseOption(page.getByRole('dialog').getByRole('combobox').first(), 'fox');
  await page.keyboard.press('Escape');
  await expect.poll(stored).toContain('"score1":4');

  fixture.snapshot.settings.scoreReportingMode = 'to_review';
  await expect(reportDifferent).toHaveCount(0);
  await expect.poll(stored).toBeNull();

  fixture.snapshot.settings.scoreReportingMode = 'approve_unless_disputed';
  await expect(reportDifferent).toBeVisible();
  await expect(scores).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Add characters (optional)' })).toBeVisible();
  await expect.poll(stored).toBeNull();
  await reportDifferent.click();
  await expect(scores.nth(0)).toHaveValue(String(match.score1));
  await expect(scores.nth(1)).toHaveValue(String(match.score2));
  expect(fixture.submissions).toEqual([]);
});

test('an offline failure loading the event document still allows a same-tab retry after reconnect', async ({
  page,
  context,
}) => {
  const fixture = await mockEvent(page, { role: 'player' });
  const match = fixture.snapshot.matches.find((row) => row.status === 'playing')!;
  await page.goto(`/play/${PLAN_ID}?match=${match.id}`);
  const card = page.locator(`[data-player-match-id="${match.id}"]`);
  const score = card.getByRole('spinbutton').first();
  await score.fill('2');
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem('nemesis:score-drafts:v1')))
    .toContain('"score1":2');
  await page.evaluate(() => {
    document.documentElement.dataset.beforeOffline = 'true';
  });
  await context.setOffline(true);
  try {
    await expect(page.reload()).rejects.toThrow('ERR_INTERNET_DISCONNECTED');
  } finally {
    await context.setOffline(false);
  }
  await page.reload();
  await expect(page.locator('html')).not.toHaveAttribute('data-before-offline', 'true');
  await expect(score).toHaveValue('2');
  expect(fixture.submissions).toEqual([]);
});

test('a definitive reporting denial retires even a draft started during the first private check', async ({
  page,
}) => {
  const fixture = await mockEvent(page, { role: 'player' });
  const match = fixture.snapshot.matches.find((row) => row.status === 'playing')!;
  let finishVerification!: () => void;
  const verification = new Promise<void>((resolve) => {
    finishVerification = resolve;
  });
  let denied = true;
  await page.route('**/api/trpc/*eventOps.myReports*', async (route) => {
    await verification;
    if (!denied) return route.fallback();
    const url = new URL(route.request().url());
    const error = {
      error: {
        message: 'Reporting access is unavailable.',
        code: -32003,
        data: { code: 'FORBIDDEN', httpStatus: 403 },
      },
    };
    await route.fulfill({
      status: 403,
      json: url.searchParams.has('batch')
        ? decodeURIComponent(url.pathname)
            .split(',')
            .map(() => error)
        : error,
    });
  });
  try {
    await page.goto(`/play/${PLAN_ID}?match=${match.id}`);
    const card = page.locator(`[data-player-match-id="${match.id}"]`);
    const scores = card.getByRole('spinbutton');
    await scores.first().fill('2');
    await expect(scores.first()).toHaveValue('2');
    finishVerification();
    await expect(scores).toHaveCount(0);

    denied = false;
    await expect(scores.first()).toHaveValue('0');
    expect(fixture.submissions).toEqual([]);
  } finally {
    finishVerification();
  }
});
