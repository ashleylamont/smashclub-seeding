import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mockEvent, PLAN_ID, PLAYER_NAME, ready } from './fixtures';

const finalLabel = 'Upper · Championship · Final';
const semifinalLabel = 'Upper · Championship · Semi-final 2';

async function finalsFixture(page: Page, role?: 'player') {
  const fixture = await mockEvent(page, { role, bracket: true });
  const { matches, nativeBrackets, entrants, stations, stationQueues } = fixture.snapshot;
  const final = matches.find((match) => match.id === 'fixture-final')!;
  const semifinal = matches.find((match) => match.id === 'fixture-semi-b')!;
  const fallback = matches.find((match) => match.id === 'fixture-semi-a')!;
  const poolMatch = matches.find((match) => match.status === 'playing')!;
  const opponent = entrants.find((entrant) => entrant.name === 'Daisy')!;
  nativeBrackets[0]!.entrantIds.push(opponent.id);
  Object.assign(semifinal, {
    label: semifinalLabel,
    labelFromStructure: true,
    player2Id: opponent.id,
    player2Name: opponent.name,
    status: 'complete',
    winnerId: semifinal.player1Id,
    score1: 2,
    score2: 1,
    outcome: 'played',
    resultUpdatedAt: '2026-10-04T12:00:00Z',
  });
  Object.assign(final, {
    label: finalLabel,
    labelFromStructure: true,
    player2Id: semifinal.player1Id,
    player2Name: semifinal.player1Name,
    status: 'playing',
    started: true,
    stationId: poolMatch.stationId,
  });
  fallback.resultUpdatedAt = '2026-10-04T11:00:00Z';
  for (const station of [...stations, ...stationQueues])
    if (station.currentMatchId === poolMatch.id) station.currentMatchId = final.id;
  Object.assign(poolMatch, {
    status: 'complete',
    stationId: null,
    winnerId: poolMatch.player1Id,
    score1: 2,
    score2: 0,
    outcome: 'played',
  });
  return { ...fixture, final };
}

for (const theme of ['dark', 'light'] as const) {
  for (const [width, height] of [
    [390, 844],
    [1440, 900],
  ]) {
    for (const reporter of ['account', 'guest'] as const) {
      test(`${reporter} sees one native finals caption at ${width}px in ${theme}`, async ({
        page,
      }, testInfo) => {
        await page.setViewportSize({ width, height });
        await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
        const fixture = await finalsFixture(page, reporter === 'account' ? 'player' : undefined);
        const params = new URLSearchParams({
          match: fixture.final.id,
          player: fixture.final.player1Id!,
        });
        if (reporter === 'guest') {
          fixture.responses['eventOps.guests.redeem'] = {
            sessionToken: 'native-caption-fixture-session',
            expiresAt: null,
          };
          fixture.responses['eventOps.guests.matches'] = { ...fixture.snapshot, reports: [] };
          await page.goto(`/guest/${PLAN_ID}?${params}#token=native-caption-fixture-invitation`);
          await expect(page.getByText('Reporting with your venue guest pass.')).toBeVisible();
        } else {
          await page.goto(`/play/${PLAN_ID}?${params}`);
        }
        const reporting = page.getByRole('region', { name: 'Find my matches and report scores' });
        const card = reporting.locator('article.ops-match').filter({ hasText: finalLabel });
        const score = card.getByRole('spinbutton').first();
        await expect(score).toBeEnabled();
        await score.press('ArrowUp');
        await expect(score).toHaveValue('1');
        await ready(page);
        await card.screenshot({ path: testInfo.outputPath('score-card.png') });
        await page.getByRole('button', { name: 'Full draw & bracket standings' }).click();
        await expect(page.locator('.event-brackets')).toBeVisible();
        await expect(score).toHaveValue('1');
        await page.evaluate(() => scrollTo(0, 0));
        await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
        await page.mouse.move(0, 0);
        await ready(page);
        await page.screenshot({ path: testInfo.outputPath('reporting.png'), fullPage: true });
        await expect(card.locator('.ops-match-meta > span').first()).toHaveText(finalLabel);
        await expect(reporting.getByText('upper · Semi-final A', { exact: true })).toBeVisible();
        await expect(card.getByRole('heading')).toContainText(PLAYER_NAME);
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
        expect(fixture.unexpected).toEqual([]);
      });
    }
  }

  for (const [width, height] of [
    [1280, 720],
    [1920, 1080],
  ]) {
    test(`OBS keeps one native finals caption at ${width}x${height} with ${theme} preference`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: theme });
      const fixture = await finalsFixture(page);
      await page.goto(`/overlay/${PLAN_ID}?station=${fixture.final.stationId}&controls=0`);
      const rail = page.getByRole('region', { name: 'Recent resolved sets' });
      const result = rail.locator('[data-match-id="fixture-semi-b"]');
      await expect(result).toBeVisible();
      await expect(page.getByLabel('Current match')).toContainText(PLAYER_NAME);
      await ready(page);
      await page.screenshot({ path: testInfo.outputPath('overlay.png'), omitBackground: true });
      await expect(result.locator('small')).toHaveText(semifinalLabel);
      await expect(result).toHaveAccessibleName(`${semifinalLabel} · Peach 2–1 Daisy`);
      await expect(
        rail.getByText('Upper · Championship · Semi-final A', { exact: true }),
      ).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(
        (
          await new AxeBuilder({ page })
            .include('.event-overlay')
            .withTags(['wcag2a', 'wcag2aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
  }
}
