import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { chooseOption } from '../test-support/controls';
import { mockEvent, PLAN_ID, ready } from './fixtures';

for (const theme of ['dark', 'light'] as const) {
  for (const width of [390, 1440]) {
    test(`opens the reviewed finals recovery from attendance at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const fixture = await mockEvent(page, { role: 'player', idle: true });
      Object.assign(fixture.overview.plan, {
        bracketMode: 'native',
        competitionFormat: 'singles',
        structure: 'dual_division',
        liveOwned: true,
      });
      const source = fixture.overview.matches.find(
        ({ division, poolIndex }) => division === 'upper' && poolIndex === 0,
      )!;
      const entrantIds = [source.player1Id!, source.player2Id!];
      const entrant = fixture.overview.entrants.find(({ id }) => id === entrantIds[0])!;
      entrant.name = 'Alexandria with a long tournament alias from Western Sydney';
      const upper = { id: 'upper-finals', division: 'upper' };
      const lower = { id: 'lower-finals', division: 'lower' };
      const brackets = [upper, lower].map((bracket) => ({
        ...bracket,
        stage: 'main',
        entrantIds,
        standings: [],
        complete: false,
      }));
      Object.assign(fixture.overview, { nativeBrackets: brackets });
      const scoped = width === 1440 && theme === 'dark';
      const bracketIds = scoped ? [upper.id] : [upper.id, lower.id];
      const scope = { division: 'upper', bracketIds };
      let frozen = true;
      const reviews: unknown[] = [];
      const resets: unknown[] = [];
      fixture.responses['eventOps.delivery.status'] = { configured: false };
      fixture.queryResponses.set('eventOps.previewAttendance', (input) => {
        reviews.push(input);
        return {
          allowed: !frozen,
          issues: frozen ? ['Remove unplayed finals before changing the pool draw.'] : [],
          ...(frozen && { finalsRemoval: scoped ? scope : { bracketIds } }),
          warnings: [],
          requiresExternalAcknowledgement: false,
          requiresRedistributionApproval: true,
          relocations: entrantIds.map((playerId) => ({
            playerId,
            fromPoolIndex: 0,
            toPoolIndex: 1,
          })),
          affectedMatches: [{ id: source.id, label: source.label, status: source.status }],
          division: 'upper',
          poolSize: 2,
          poolIndex: 0,
          addedMatches: 0,
          revisionToken: frozen ? 'frozen-attendance' : 'reviewed-attendance',
        };
      });
      fixture.responses['eventOps.native.preview'] = {
        seedPolicy: 'pool_place_whr_v1',
        existing: true,
        allowed: false,
        issues: [],
        replacing: false,
        resetAllowed: !scoped,
        resetIssues: scoped ? ['Finals have actual play and cannot be reset.'] : [],
        resetCallMatchIds: [],
        resetRevisionToken: 'remove-all',
        resetBracketIds: [upper.id, lower.id].sort(),
        divisionResets: scoped
          ? [
              {
                scope,
                revisionToken: 'remove-upper',
                resetAllowed: true,
                resetIssues: [],
                resetCallMatchIds: [],
              },
            ]
          : [],
        revisionToken: 'reviewed-draw',
        poolOrders: [],
        waitingStages: [],
        brackets: [],
      };
      await page.route('**/api/trpc/eventOps.native.reset*', async (route) => {
        const batched = new URL(route.request().url()).searchParams.has('batch');
        const body = route.request().postDataJSON();
        resets.push(batched ? body[0] : body);
        frozen = false;
        brackets.splice(0, scoped ? 1 : brackets.length);
        const result = { result: { data: { removed: bracketIds.length } } };
        await route.fulfill({ json: batched ? [result] : result });
      });
      await page.goto(`/operate/${PLAN_ID}?view=players`);
      await ready(page);
      const attendance = page.locator('section.card').filter({
        has: page.getByRole('heading', { name: 'Attendance changes', exact: true }),
      });
      await chooseOption(
        attendance.getByRole('combobox', { name: 'Change', exact: true }),
        'redistribute',
      );
      await chooseOption(
        attendance.getByRole('combobox', { name: 'Player', exact: true }),
        entrantIds[0],
      );
      const reason = attendance.getByLabel('Reason', { exact: true });
      const draft = 'Keep the two players together after reviewing finals';
      await reason.fill(draft);
      await attendance.getByRole('button', { name: 'Preview attendance change' }).press('Enter');
      const preview = attendance.locator('.ops-attendance-preview');
      const apply = preview.getByRole('button', { name: 'Apply this change' });
      const recovery = preview.getByRole('button', { name: 'Review finals removal' });
      await expect(recovery).toBeEnabled();
      await expect(apply).toBeDisabled();
      if (scoped) await expect(preview).toContainText('choose Upper finals only');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      const audit = await new AxeBuilder({ page })
        .include('.ops-page')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze();
      expect(audit.violations).toEqual([]);
      await preview.screenshot({ path: testInfo.outputPath('blocked-attendance.png') });

      await recovery.press('Enter');
      await expect(page).toHaveURL(/view=draw/);
      const previewFinals = page.getByRole('button', { name: 'Preview finals', exact: true });
      await expect(previewFinals).toBeFocused();
      expect(resets).toHaveLength(0);
      await previewFinals.press('Enter');
      const review = page.getByRole('region', { name: 'Finals removal' });
      if (scoped) {
        await expect(review.getByRole('button', { name: 'Remove unplayed finals' })).toBeDisabled();
        await chooseOption(review.getByRole('combobox', { name: 'Finals to remove' }), 'upper');
      }
      const remove = review.getByRole('button', {
        name: scoped ? 'Remove unplayed Upper finals' : 'Remove unplayed finals',
      });
      await remove.press('Enter');
      const confirmation = page.getByRole('alertdialog');
      await expect(confirmation).toHaveAccessibleDescription(/Pool results.*stay recorded/);
      await confirmation.getByRole('button', { name: 'Cancel', exact: true }).press('Enter');
      await expect(remove).toBeFocused();
      expect(resets).toHaveLength(0);
      await remove.press('Enter');
      await confirmation.getByRole('button', { name: 'Confirm', exact: true }).press('Enter');
      await expect.poll(() => resets.length).toBe(1);
      expect(resets[0]).toMatchObject({
        planId: PLAN_ID,
        revisionToken: scoped ? 'remove-upper' : 'remove-all',
        ...(scoped && { scope }),
      });

      await page.getByRole('tab', { name: 'Players', exact: true }).press('Enter');
      await expect(reason).toHaveValue(draft);
      await expect(attendance.getByRole('combobox', { name: 'Player', exact: true })).toContainText(
        entrant.name,
      );
      await expect(recovery).toHaveCount(0);
      await expect(apply).toBeDisabled();
      await preview.getByRole('button', { name: 'Refresh attendance preview' }).press('Enter');
      await expect(preview.getByRole('heading', { name: 'Change preview' })).toBeFocused();
      await expect(preview.getByText(/Pool A → Pool B/)).toHaveCount(2);
      const approval = preview.getByRole('checkbox', { name: /I approve moving these players/ });
      await expect(approval).not.toBeChecked();
      await expect(apply).toBeDisabled();
      await approval.press('Space');
      await expect(apply).toBeEnabled();
      expect(reviews).toHaveLength(2);
      expect(reviews[1]).toEqual(reviews[0]);
      expect(fixture.unexpected).toEqual([]);
      await preview.screenshot({ path: testInfo.outputPath('refreshed-attendance.png') });
    });
  }
}
