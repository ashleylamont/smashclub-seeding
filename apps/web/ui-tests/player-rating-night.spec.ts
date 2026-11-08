import { expect, test, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { rpcProcedures } from '../test-support/rpcBatch';
import { ready } from './fixtures';
import type { trpc } from '../src/lib/trpc';

const playerId = 'ac184b5a-fba4-4bc9-9ee9-c1610d3c8373';
const recomputeId = '9c935fcc-1df1-4a9b-b2fc-733150e1bc4f';
type Impact = Awaited<ReturnType<typeof trpc.public.whrResultImpact.query>>;
const setIds = ['47ea5b38-8fb2-4690-9c2c-2652c3ba515e', '3acb2905-3434-4721-9a5f-5b5265b64255'];
const nights = [
  {
    eventKey: '2025-07-31',
    played: true,
    preRating: 1608.6756,
    postRating: 1576.6215,
    postRd: 105,
    revisedRating: 1620,
    prePenalty: 0,
    postPenalty: 0,
  },
  {
    eventKey: '2026-08-25',
    played: false,
    preRating: 1620,
    postRating: 1634.0591,
    postRd: 109,
    revisedRating: 1640,
    prePenalty: 120,
    postPenalty: 120,
  },
  {
    eventKey: '2026-09-29',
    played: true,
    preRating: 1634.0591,
    postRating: 1659.753,
    postRd: 100,
    revisedRating: 1659.753,
    prePenalty: 120,
    postPenalty: 0,
  },
];

async function mockProfile(page: Page, impact?: Impact) {
  const state = { impact, impactCalls: 0 };
  const profile = {
    recomputeId: impact ? recomputeId : undefined,
    player: {
      id: playerId,
      name: 'Returning Player With An Exceptionally Long Tournament Alias',
      companyCode: null,
      companyName: 'Smash Club',
      verified: false,
      characters: [],
    },
    rating: {
      rank: 7,
      league: 'Club',
      clubRating: 1659.753,
      skillRating: 1659.753,
      skillSd: 100,
      activityPenalty: 0,
      nextMissPenalty: 0,
      missedEvents: 0,
      attendanceStreak: 1,
      isProvisional: false,
      wins: 1,
      losses: 1,
      eventCount: 2,
      tournamentCount: 2,
      mainMatchCount: 2,
      rookieMatchCount: 0,
      matchCount: 2,
      uniqueOpponentCount: 2,
      rookieRatio: 0,
      sampleConfidence: 0.48,
      lastPlayedDate: '2026-09-29T08:30:00Z',
    },
    nights,
    events: nights
      .filter((night) => night.played)
      .map((night, seq) => ({
        seq,
        isDecay: false,
        won: seq === 1,
        postRating: night.postRating,
        postRd: night.postRd,
        revisedRating: night.revisedRating,
        revisedSd: night.postRd,
        weight: 1,
        tournamentId: `bracket-${seq}`,
        tournamentName: `Singles bracket ${seq + 1}`,
        tournamentDate: `${night.eventKey}T08:30:00Z`,
        setId: setIds[seq],
        resultStage: 'final',
        isRookie: false,
        opponentPlayerId: null,
        opponentName: 'Practice opponent',
      })),
    doublesResults: [],
  };
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/api/auth/')) return route.fulfill({ json: null });
    if (url.endsWith('/api/live'))
      return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
    const results = rpcProcedures(url).map((procedure) => {
      if (procedure === 'public.whrResultImpact') {
        state.impactCalls++;
        expect(state.impact).toBeDefined();
        return { result: { data: state.impact } };
      }
      expect(procedure).toBe('public.player');
      return { result: { data: profile } };
    });
    await route.fulfill({ json: new URL(url).searchParams.has('batch') ? results : results[0] });
  });
  return state;
}

for (const theme of ['dark', 'light'] as const) {
  for (const width of [390, 1440]) {
    test(`return-night WHR breakdown at ${width}px in ${theme} mode`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      await mockProfile(page);
      await page.goto(`/players/${playerId}`);
      const breakdown = page.getByRole('region', { name: 'Rating changes by night' });
      await expect(breakdown).toContainText('1634.1 → 1659.8');
      await expect(breakdown).toContainText('+25.7');
      await expect(breakdown).toContainText('+57.4');
      await expect(breakdown).toContainText('120 → 0');
      await expect(page.getByRole('heading', { name: 'Match log (2 sets)' })).toBeVisible();
      await ready(page);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      expect(overflow).toBe(0);
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
      ).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath('night-return.png'), fullPage: true });

      const picker = breakdown.getByRole('combobox', { name: 'Rating night' });
      await picker.focus();
      await picker.press('Enter');
      await expect(page.getByRole('option', { selected: true })).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(page.getByRole('option', { name: '25 Aug 2026' })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(picker).toBeFocused();
      await expect(breakdown).toContainText('No rated sets for this player');
      await expect(breakdown).toContainText('Revision from other sets');
      await expect(breakdown).toContainText('+14.1');
      await expect(breakdown).not.toContainText('Revision while away');
      await expect(page.getByRole('heading', { name: 'Match log (2 sets)' })).toBeVisible();
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: testInfo.outputPath('night-missed.png'), fullPage: true });
    });
  }
}

for (const theme of ['dark', 'light'] as const) {
  for (const width of [390, 1440]) {
    test(`WHR result impact opens on demand at ${width}px in ${theme} mode`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      const result = {
        status: 'available' as const,
        effectPoints: 27.6,
        preNightSd: 110,
        firstNight: true,
        evidenceWeight: 1.5,
        forecast: null,
      };
      const fixture = await mockProfile(page, result);
      await page.goto(`/players/${playerId}`);
      const trigger = page.getByRole('button', { name: /WHR impact for Singles bracket 2/ });
      await expect(trigger).toBeVisible();
      expect(fixture.impactCalls).toBe(0);
      await trigger.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'WHR impact' });
      await expect(dialog).toContainText('About 30 points higher');
      await expect(dialog).toContainText('first rated night');
      await expect(dialog).toContainText('The set counted as ×1.5 evidence');
      await expect(dialog).toContainText('impacts do not add up');
      expect(fixture.impactCalls).toBe(1);
      await ready(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
      ).toEqual([]);
      await dialog.screenshot({ path: testInfo.outputPath('whr-impact.png') });
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();

      fixture.impact = {
        ...result,
        effectPoints: -0.8,
        firstNight: false,
        forecast: { winProbability: 0.642, opponentSkill: 1512 },
      };
      await page.keyboard.press('Enter');
      await expect(dialog).toContainText('Slightly lower skill estimate');
      await expect(dialog).toContainText('±220 points');
      await expect(dialog).toContainText('chance of winning at about 65%');
      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();

      fixture.impact = { status: 'unavailable', reason: 'history_changed' };
      await page.keyboard.press('Enter');
      await expect(dialog).toContainText('Check again after ratings are recomputed');
      await expect(dialog).not.toContainText('points lower');
      expect(fixture.impactCalls).toBe(3);
    });
  }
}
