import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { mockEvent, PLAN_ID, PLAYER_NAME, ready } from './fixtures';
import { chooseOption } from '../test-support/controls';

for (const theme of ['dark', 'light'] as const) {
  for (const [width, height] of [
    [390, 844],
    [1440, 900],
  ]) {
    test(`linked handoff identifies the forfeit winner at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const fixture = await mockEvent(page, { role: 'admin' });
      Object.assign(fixture.overview.plan, { bracketMode: 'challonge', liveOwned: false });
      Object.assign(fixture.overview.brackets[0]!, { slug: 'linked-forfeit-fixture' });
      fixture.responses['eventOps.delivery.status'] = { enabled: true, hasCredentials: true };
      const completed = fixture.overview.matches.filter((match) => match.status === 'complete');
      for (const match of completed) match.syncState = 'synced';
      const forfeit = completed[0]!;
      const played = completed[1]!;
      Object.assign(forfeit, {
        division: 'upper',
        stage: 'main',
        poolIndex: null,
        label: 'upper main · M8',
        player1Name: PLAYER_NAME,
        player2Name: 'Jordan with a long tournament alias',
        sourceSetId: 'linked-forfeit-set',
        sourceKey: 'set:linked-forfeit-set',
        syncState: 'pending',
        outcome: 'forfeit',
        winnerId: forfeit.player2Id,
        score1: 0,
        score2: 0,
      });
      Object.assign(played, {
        division: 'upper',
        stage: 'main',
        poolIndex: null,
        label: 'upper main · M9',
        sourceSetId: 'linked-played-set',
        sourceKey: 'set:linked-played-set',
        syncState: 'pending',
        outcome: 'played',
        winnerId: played.player1Id,
        score1: 2,
        score2: 1,
      });

      await page.goto(`/operate/${PLAN_ID}?view=draw`);
      const disclosure = page.getByRole('button', { name: 'Challonge integration' });
      await expect(disclosure).toBeVisible();
      await disclosure.press('Enter');
      const handoff = page.locator('section.card').filter({
        has: page.getByRole('heading', { name: /^Challonge handoff/ }),
      });
      const summary = handoff.getByRole('textbox', { name: 'Results to reconcile' });
      await expect(summary).toBeVisible();
      await expect(handoff.getByRole('button', { name: 'Send to Challonge' })).toHaveCount(1);
      await expect(
        handoff
          .locator('.ops-report')
          .filter({ hasText: played.label })
          .getByRole('button', { name: 'Send to Challonge' }),
      ).toBeVisible();
      const downloaded = page.waitForEvent('download');
      await handoff.getByRole('button', { name: 'Download score handoff' }).press('Enter');
      const download = await downloaded;
      const copy = await readFile((await download.path())!, 'utf8');
      expect(download.suggestedFilename()).toBe('nemesis-score-handoff.txt');
      const lines = (await summary.inputValue()).split('\n');
      expect(copy).toContain(lines.join('\n'));
      await page.evaluate(() => scrollTo(0, 0));
      await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
      await page.mouse.move(0, 0);
      await ready(page);
      await page.screenshot({ path: testInfo.outputPath('linked-draw.png'), fullPage: true });
      await handoff.screenshot({ path: testInfo.outputPath('handoff.png') });
      expect(lines.find((line) => line.startsWith(forfeit.label))).toBe(
        `${forfeit.label}: ${forfeit.player2Name} wins by forfeit against ${forfeit.player1Name} (pending)`,
      );
      await expect(handoff).toContainText('Enter forfeits in Challonge.');
      expect(lines.find((line) => line.startsWith(played.label))).toBe(
        `${played.label}: ${played.player1Name} 2 – 1 ${played.player2Name} (played; pending)`,
      );
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
      await page.getByRole('tab', { name: 'Run matches', exact: true }).press('Enter');
      const run = page.getByRole('tabpanel', { name: 'Run matches', exact: true });
      await chooseOption(run.getByRole('combobox', { name: 'View', exact: true }), 'complete');
      const caption = 'Upper Championship · M9';
      const playedCard = run.locator('article.ops-match').filter({ hasText: caption });
      await expect(playedCard.getByText(caption, { exact: true })).toBeVisible();
      await expect(
        playedCard.getByRole('combobox', { name: `Station for ${caption}`, exact: true }),
      ).toBeVisible();
      await expect(playedCard).toContainText(played.player1Name!);
      const forfeitCard = run.locator('article.ops-match').filter({
        hasText: 'Upper Championship · M8',
      });
      await expect(forfeitCard).toContainText(PLAYER_NAME);
      await expect(forfeitCard).toContainText('Jordan with a long tournament alias');
      await page.evaluate(() => scrollTo(0, 0));
      await ready(page);
      await page.screenshot({ path: testInfo.outputPath('linked-run.png'), fullPage: true });
      await run
        .getByRole('button', { name: 'Pool queues and stations', exact: true })
        .press('Enter');
      const trigger = run.getByRole('button', { name: 'Print bracket backup sheets', exact: true });
      await trigger.press('Enter');
      const print = page.getByRole('dialog', { name: 'Print bracket backup sheets' });
      const sheet = print.locator('.bracket-backup-page').filter({
        has: page.getByRole('heading', { name: 'Upper Championship', exact: true }),
      });
      for (const identifier of ['M8', 'M9'])
        await expect(sheet.getByRole('cell', { name: identifier, exact: true })).toBeVisible();
      await expect(sheet).toContainText('Online: 2–1');
      await expect(sheet).not.toContainText('upper main ·');
      await expect(sheet).toContainText(PLAYER_NAME);
      await ready(page);
      await sheet.screenshot({ path: testInfo.outputPath('linked-bracket-sheet.png') });
      expect(
        (
          await new AxeBuilder({ page })
            .include('.bracket-backup-dialog')
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();
      expect(fixture.unexpected).toEqual([]);
    });
  }
}
