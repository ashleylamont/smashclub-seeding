import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Locator } from '@playwright/test';
import { chooseOption } from '../test-support/controls';
import { mockEvent, PLAN_ID, ready } from './fixtures';

const first = 'Willa with a long late-arrival alias from Western Sydney';
const second = 'Miles with an equally long doubles teammate alias';
const reason = 'Both players arrived before Lower Pool B started';

async function choose(control: Locator, value: string) {
  await control.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await chooseOption(control, value);
}

for (const theme of ['dark', 'light'] as const) {
  for (const width of [390, 1440]) {
    test(`late pair reviews the exact division and workload at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const fixture = await mockEvent(page, { role: 'admin', idle: true });
      Object.assign(fixture.overview.plan, {
        name: 'Late doubles pair rehearsal',
        competitionFormat: 'doubles',
        structure: 'dual_division',
        liveOwned: true,
      });
      fixture.responses['eventOps.delivery.status'] = { configured: false };
      fixture.queryResponses.set('public.searchPlayers', (input) =>
        (input as { query: string }).query === 'Willa'
          ? [{ id: 'first', name: first, companyCode: null }]
          : [{ id: 'second', name: second, companyCode: null }],
      );
      const called = fixture.overview.matches.find(
        (match) => match.status === 'ready' && match.division === 'lower' && match.poolIndex === 1,
      )!;
      const unrelated = fixture.overview.matches.find(
        (match) =>
          match.status === 'ready' &&
          (match.division !== called.division || match.poolIndex !== called.poolIndex),
      )!;
      Object.assign(called, { player1Name: 'Eligible Pool B call' });
      Object.assign(unrelated, { player1Name: 'Unrelated pool call' });
      for (const match of [called, unrelated])
        Object.assign(match, { status: 'playing', started: false, called: true });
      const reviewedInputs: unknown[] = [];
      let blocked = true;
      const issue = 'Return the untaken calls in Pool B, then review again.';
      fixture.queryResponses.set('eventOps.previewLateDoublesPair', (input) => {
        reviewedInputs.push(input);
        return {
          allowed: !blocked,
          issues: blocked ? [issue] : [],
          returnCallMatchIds: blocked ? [called.id] : [],
          memberNames: [first, second],
          division: 'lower',
          poolIndex: blocked ? null : 1,
          assignedTeams: 4,
          meetings: 2,
          addedMatches: 8,
          pendingForfeits: 2,
          totalMatches: 20,
          nextSeed: 9,
          finals: {
            championship: { before: 4, after: 4 },
            consolation: { before: 3, after: 4 },
          },
          revisionToken: 'late-pair-revision',
        };
      });
      fixture.responses['eventOps.applyLateDoublesPair'] = { applied: true, sequence: 7 };
      const returnedCalls: unknown[] = [];
      const returnPath = '/api/trpc/eventOps.updateMatch';
      await page.route(`**${returnPath}*`, async (route) => {
        const batched = new URL(route.request().url()).searchParams.has('batch');
        const body = route.request().postDataJSON();
        returnedCalls.push(batched ? body[0] : body);
        blocked = false;
        Object.assign(called, { status: 'ready', called: false, stationId: null });
        const response = { result: { data: called } };
        await route.fulfill({ json: batched ? [response] : response });
      });
      await page.goto(`/operate/${PLAN_ID}?view=players`);
      const panel = page.locator('section.card').filter({
        has: page.getByRole('heading', { name: 'Pair attendance', exact: true }),
      });
      await choose(panel.getByRole('combobox', { name: 'Change', exact: true }), 'late_pair');
      const firstSearch = panel.getByRole('textbox', { name: 'Find first player by alias' });
      await firstSearch.fill('Willa');
      await choose(panel.getByRole('combobox', { name: 'First player', exact: true }), 'first');
      await panel.getByRole('textbox', { name: 'Find second player by alias' }).fill('Miles');
      await choose(panel.getByRole('combobox', { name: 'Second player', exact: true }), 'second');
      await panel.getByRole('textbox', { name: 'Reason for adding the pair' }).fill(reason);
      const preview = panel.getByRole('button', { name: 'Preview late pair' });
      await expect(preview).toBeDisabled();
      await choose(panel.getByRole('combobox', { name: 'Division', exact: true }), 'lower');
      await preview.press('Enter');

      const heading = panel.getByRole('heading', { name: 'Late pair preview' });
      await expect(heading).toBeFocused();
      const confirm = panel.getByRole('button', { name: 'Confirm late pair' });
      await expect(confirm).toHaveCount(0);
      await expect(panel.getByText(issue)).toBeVisible();
      const openCall = panel.getByRole('button', { name: /^Open call for/ });
      await expect(openCall).toHaveCount(1);
      await expect(openCall).toHaveAccessibleName(/Eligible Pool B call/);
      await panel.locator('.ops-attendance-preview').screenshot({
        path: testInfo.outputPath('late-pair-blocked.png'),
      });
      await openCall.press('Enter');
      const returnCall = page.locator(`[id="return-call-${called.id}"]`);
      await expect(returnCall).toBeFocused();
      const returned = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' && new URL(response.url()).pathname === returnPath,
      );
      await returnCall.press('Enter');
      expect((await returned).ok()).toBe(true);
      expect(returnedCalls).toEqual([
        expect.objectContaining({ matchId: called.id, status: 'ready', stationId: null }),
      ]);
      await page.getByRole('tab', { name: 'Players' }).press('Enter');
      const refresh = panel.getByRole('button', { name: 'Refresh late pair preview' });
      await expect(refresh).toBeEnabled();
      await refresh.press('Enter');
      await expect(heading).toBeFocused();
      await expect(confirm).toBeEnabled();
      await expect(panel.getByText(`${first} / ${second}`, { exact: true })).toBeVisible();
      await expect(panel).toContainText('Lower · Pool B · Seed 9');
      await expect(panel).toContainText('8 additional sets · 20 total');
      await expect(panel).toContainText('2 added sets need a forfeit decision.');
      await expect(panel).toContainText('Championship 4 → 4');
      await expect(panel).toContainText('Consolation 3 → 4');
      await expect(panel).toContainText('Existing seeds and match rounds stay in place.');
      expect(reviewedInputs).toEqual(
        Array.from({ length: 2 }, () => ({
          planId: PLAN_ID,
          division: 'lower',
          memberPlayerIds: ['first', 'second'],
          reason,
        })),
      );
      await ready(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(
        (
          await new AxeBuilder({ page })
            .include('.ops-page')
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      await page.evaluate(() => scrollTo(0, 0));
      await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
      await page.screenshot({
        path: testInfo.outputPath('late-pair-full-route.png'),
        fullPage: true,
      });
      await panel.locator('.ops-attendance-preview').screenshot({
        path: testInfo.outputPath('late-pair-preview.png'),
      });

      await heading.focus();
      await page.keyboard.press('Tab');
      await expect(confirm).toBeFocused();
      const posted = page.waitForRequest(
        (request) =>
          request.method() === 'POST' && request.url().includes('eventOps.applyLateDoublesPair'),
      );
      await confirm.press('Enter');
      const body = (await posted).postDataJSON();
      expect(body[0] ?? body).toMatchObject({
        planId: PLAN_ID,
        division: 'lower',
        memberPlayerIds: ['first', 'second'],
        reason,
        revisionToken: 'late-pair-revision',
        requestId: expect.any(String),
      });
      await expect(panel.getByRole('status')).toContainText(
        'Pair added to Lower Pool B. 8 sets added after the existing rounds.',
      );
      await expect(firstSearch).toBeFocused();
      expect(fixture.unexpected).toEqual([]);
    });
  }
}
