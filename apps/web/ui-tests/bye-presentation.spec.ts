import { expect, test } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { mockEvent, PLAN_ID, ready } from './fixtures';
import { bracketFixture } from '../test/fixtures/brackets';

for (const adapter of ['signed-in', 'guest'] as const)
  test(`${adapter} completed native byes never look like played scores or pending opponents`, async ({
    page,
  }, testInfo) => {
    const fixture = await mockEvent(page, { role: 'player', bracket: true });
    const base = fixture.snapshot.matches.find((match) => match.nativeBracketId)!;
    const generated = bracketFixture(5, false);
    const bye = generated.find((match) => match.outcome === 'bye')!;
    // Reproduce a later automatic resolution with a recorded feeder and real winner identity.
    const propagated = {
      ...bye,
      id: 'propagated-bye',
      label: 'Propagated bye',
      parent1MatchId: bye.id,
      nativeRound: 2,
    };
    const pending = {
      ...bye,
      id: 'pending-feed',
      label: 'Pending feeder',
      status: 'blocked',
      outcome: null,
      winnerId: null,
      parent2MatchId: 'unfinished-feed',
    };
    const forfeit = {
      ...bye,
      id: 'forfeit',
      label: 'Forfeit result',
      outcome: 'forfeit',
      player2Id: 'opponent',
      player2Name: 'Opponent',
      score1: 99,
      score2: 0,
    };
    const noContest = {
      ...forfeit,
      id: 'no-contest',
      label: 'No contest result',
      status: 'blocked',
      outcome: null,
      winnerId: null,
      blockedReason: 'Both players withdrawn: no contest; no winner or score recorded',
    };
    fixture.snapshot.matches = [bye, propagated, pending, forfeit, noContest].map((match) =>
      Object.assign({ ...base }, match),
    );
    fixture.snapshot.stationQueues.length = 0;
    fixture.snapshot.poolRounds.length = 0;
    if (adapter === 'guest') {
      fixture.snapshot.settings.playerReports = false;
      fixture.responses['eventOps.guests.redeem'] = {
        sessionToken: 'fixture-venue-pass'.repeat(3),
        expiresAt: null,
      };
      fixture.responses['eventOps.guests.matches'] = { ...fixture.snapshot, reports: [] };
    }
    await page.goto(
      `/play/${PLAN_ID}?player=${bye.winnerId}${adapter === 'guest' ? '#token=fixture-invitation' : ''}`,
    );
    for (const label of [bye.label, propagated.label]) {
      const card = page.locator('article.ops-match').filter({ hasText: label });
      await expect(card).toContainText('Bye');
      await expect(card).toContainText('advanced automatically');
      await expect(card.getByRole('heading')).not.toContainText(' vs ');
      await expect(card.getByRole('spinbutton')).toHaveCount(0);
      await expect(card.getByRole('button')).toHaveCount(0);
      await expect(card).not.toContainText('Confirmed result:');
    }
    const pendingCard = page.locator('article.ops-match').filter({ hasText: pending.label });
    await expect(pendingCard).toContainText('Awaiting opponent');
    await expect(pendingCard).not.toContainText('Bye');
    await expect(pendingCard.getByRole('spinbutton')).toHaveCount(0);
    const forfeitCard = page.locator('article.ops-match').filter({ hasText: forfeit.label });
    await expect(forfeitCard).toContainText('Opponent forfeits');
    await expect(forfeitCard).not.toContainText('99');
    await expect(forfeitCard.getByRole('button')).toHaveCount(0);
    const noContestCard = page.locator('article.ops-match').filter({ hasText: noContest.label });
    await expect(noContestCard).toContainText('No contest');
    await expect(noContestCard).not.toContainText('99');
    await expect(noContestCard.getByRole('button')).toHaveCount(0);
    const results = page.locator('#event-results');
    await expect(results).toContainText('advanced automatically');
    await expect(results).not.toContainText('To be decided');
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await ready(page);
      expect(
        (
          await new AxeBuilder({ page })
            .include('.player-event-hub')
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: testInfo.outputPath(`bye-${adapter}-${viewport.width}.png`),
        fullPage: true,
      });
    }
    expect(fixture.submissions).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
