import { readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { bracketCaptureOptions, mockEvent, PLAN_ID, ready } from './fixtures';

const captureStyle = readFileSync(bracketCaptureOptions.stylePath, 'utf8');

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test(`opens the first current score disagreement at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const { overview, unexpected } = await mockEvent(page, { role: 'admin' });
      const recorded = overview.matches.find((match) => match.status === 'complete')!;
      const forfeited = overview.matches.find(
        (match) => match.status === 'complete' && match.id !== recorded.id,
      )!;
      const playerName = recorded.player1Name;
      const [waiting, ordinary] = overview.matches.filter((match) => match.status === 'ready');
      const alias = 'Alexandria with a long tournament alias from Western Sydney';
      Object.assign(recorded, { player1Name: alias, score1: 2, score2: 0, outcome: 'played' });
      Object.assign(forfeited, {
        outcome: 'forfeit',
        winnerId: forfeited.player1Id,
        score1: null,
        score2: null,
      });
      const sample = overview.reports[0]!;
      const disagreement = {
        ...sample,
        id: 'current-conflict',
        matchId: recorded.id,
        status: 'pending' as const,
        isDispute: true,
        expectedRevision: recorded.revision,
        reporterLabel: 'Guest',
        score1: 1,
        score2: 2,
        outcome: 'played' as const,
      };
      overview.reports = [
        {
          ...disagreement,
          id: 'stale-conflict',
          matchId: forfeited.id,
          expectedRevision: forfeited.revision + 1,
        },
        disagreement,
        {
          ...disagreement,
          id: 'no-result',
          matchId: waiting!.id,
          expectedRevision: waiting!.revision,
        },
        {
          ...disagreement,
          id: 'pending',
          matchId: ordinary!.id,
          expectedRevision: ordinary!.revision,
          isDispute: false,
        },
        { ...disagreement, id: 'rejected', status: 'rejected' },
      ];
      await page.goto(`/operate/${PLAN_ID}?view=settings`);
      const attention = page.getByRole('region', { name: /^Needs attention/ });
      const shortcut = attention.getByRole('button', { name: 'Review disagreements' });
      const section = page.getByRole('region', { name: 'Score submissions' });
      const recordedReport = section.locator('#score-report-current-conflict');
      const checkRun = () =>
        expect(page.getByRole('tab', { name: 'Run matches', exact: true })).toHaveAttribute(
          'data-state',
          'active',
        );
      await expect(
        attention.getByText('3 conflicting score reports', { exact: true }),
      ).toBeVisible();
      await expect(page.getByText(/3 conflicting/, { exact: false })).toHaveCount(1);

      await page
        .getByRole('button', { name: 'Review score submissions', exact: true })
        .press('Enter');
      await checkRun();
      await expect(section).toBeFocused();

      await page.getByRole('tab', { name: 'Players', exact: true }).press('Enter');
      const finder = page.getByRole('region', { name: 'Find a player' });
      await finder.getByRole('searchbox').fill(playerName);
      await finder
        .getByRole('button')
        .filter({ has: page.getByText(playerName, { exact: true }) })
        .press('Enter');
      await ready(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
          .violations,
      ).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath('players-review-route.png'),
        fullPage: true,
        style: captureStyle,
      });
      await finder.getByRole('button', { name: 'Review score submissions' }).press('Enter');
      await checkRun();
      await expect(section).toBeFocused();

      await page.getByRole('tab', { name: 'Settings', exact: true }).press('Enter');
      await shortcut.press('Enter');
      await checkRun();
      await expect(recordedReport).toBeFocused();
      await expect(recordedReport).toContainText(`Recorded result · ${alias} 2–0`);
      await expect(recordedReport).toContainText(`Submitted result · ${alias} 1 – 2`);
      await expect(
        recordedReport.getByRole('button', { name: 'Use submitted result' }),
      ).toBeEnabled();
      await expect(
        recordedReport.getByRole('button', { name: 'Keep recorded result' }),
      ).toBeEnabled();
      const stale = section.locator('#score-report-stale-conflict');
      await expect(stale).toContainText('stale: match has changed');
      await expect(stale).toContainText('Recorded outcome ·');
      await expect(stale).toContainText('forfeits.');
      await expect(stale.getByRole('button', { name: 'Use submitted result' })).toBeDisabled();
      const unresolved = section.locator('#score-report-no-result');
      await expect(unresolved).toContainText('No result recorded.');
      await expect(unresolved.getByRole('button', { name: 'Reject', exact: true })).toBeEnabled();
      const pending = section.locator('#score-report-pending');
      await expect(pending).toContainText('Pending score ·');
      await expect(pending.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled();
      await expect(section.locator('#score-report-rejected')).toHaveCount(0);

      await ready(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
          .violations,
      ).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath('score-review-route.png'),
        fullPage: true,
        style: captureStyle,
      });
      await section.screenshot({
        path: testInfo.outputPath('score-review-detail.png'),
        style: captureStyle,
      });

      overview.reports = overview.reports.map((report) => ({ ...report, status: 'rejected' }));
      await page.reload();
      await expect(shortcut).toHaveCount(0);
      await expect(section).toHaveText('Score submissionsNo scores awaiting review.');
      expect(unexpected).toEqual([]);
    });
