import { expect, test, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { rpcProcedures } from '../test-support/rpcBatch';
import { chooseOption } from '../test-support/controls';
import { ready } from './fixtures';
import type { trpc } from '../src/lib/trpc';

const playerId = 'ac184b5a-fba4-4bc9-9ee9-c1610d3c8373';
const recomputeId = '9c935fcc-1df1-4a9b-b2fc-733150e1bc4f';
type Impact = Awaited<ReturnType<typeof trpc.public.whrResultImpact.query>>;
type ImpactRequest = { playerId: string; setId: string; recomputeId: string };
const setIds = ['47ea5b38-8fb2-4690-9c2c-2652c3ba515e', '3acb2905-3434-4721-9a5f-5b5265b64255'];
const effect = {
  status: 'available' as const,
  effectPoints: 27.6,
  preNightSd: 110,
  firstNight: true,
  evidenceWeight: 1.5,
  gamesWeight: 0.25,
  forecast: null,
  forecastUnavailable: 'first_night' as const,
};
const forecastEffect = {
  ...effect,
  firstNight: false,
  forecast: { winProbability: 0.32, opponentSkill: 1740 },
  forecastUnavailable: null,
};
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

async function mockProfile(
  page: Page,
  impact?: (request: ImpactRequest) => Impact | undefined | Promise<Impact | undefined>,
  live?: Promise<string>,
) {
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
        weight: seq === 0 ? 1 : 1.5,
        tournamentId: `bracket-${seq}`,
        tournamentName: `Singles bracket ${seq + 1}`,
        tournamentDate: `${night.eventKey}T08:30:00Z`,
        setId: setIds[seq],
        resultStage: seq === 0 ? 'group' : 'final',
        isRookie: false,
        opponentPlayerId: null,
        opponentName: 'Practice opponent',
      })),
    doublesResults: [],
  };
  const requests: (ImpactRequest & { at: number })[] = [];
  let active = 0;
  let maxActive = 0;
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/api/auth/')) return route.fulfill({ json: null });
    if (url.endsWith('/api/live'))
      return route.fulfill({
        contentType: 'text/event-stream',
        body: (await live) ?? ': fixture\n\n',
      });
    const { searchParams } = new URL(url);
    const batched = searchParams.has('batch');
    const input = JSON.parse(searchParams.get('input') ?? '{}');
    const results = await Promise.all(
      rpcProcedures(url).map(async (procedure, index) => {
        if (procedure === 'public.whrResultImpact') {
          const request: ImpactRequest = batched ? input[index] : input;
          requests.push({ ...request, at: performance.now() });
          maxActive = Math.max(maxActive, ++active);
          try {
            const data = await impact?.(request);
            return data
              ? { result: { data } }
              : {
                  error: {
                    message: 'Fixture connection error',
                    code: -32603,
                    data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
                  },
                };
          } finally {
            active--;
          }
        }
        expect(procedure).toBe('public.player');
        return { result: { data: profile } };
      }),
    );
    await route.fulfill({ json: batched ? results : results[0] });
  });
  return { profile, requests, maxActive: () => maxActive };
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

function addRatedEvents(
  profile: Awaited<ReturnType<typeof mockProfile>>['profile'],
  count: number,
) {
  for (let seq = profile.events.length; seq < count; seq++) {
    profile.events.push({
      ...profile.events[0]!,
      seq,
      setId: `b9c935fc-1df1-4a9b-b2fc-${String(seq).padStart(12, '0')}`,
      tournamentId: `bracket-${seq}`,
      tournamentName: `Singles bracket ${seq + 1}`,
      tournamentDate: profile.events[1]!.tournamentDate,
      resultStage: seq % 2 === 0 ? 'group' : 'final',
    });
  }
  Object.assign(profile.rating, {
    losses: count - 1,
    matchCount: count,
    mainMatchCount: count,
    tournamentCount: count,
  });
}

for (const theme of ['dark', 'light'] as const) {
  for (const width of [390, 1440]) {
    test(`WHR result impact is inline at ${width}px in ${theme} mode`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      const fixture = await mockProfile(page, ({ setId }) => {
        if (setId === setIds[1]) return forecastEffect;
        if (setId === setIds[0]) return { ...effect, effectPoints: -0.8 };
        return {
          ...effect,
          firstNight: false,
          forecastUnavailable: 'disconnected',
          effectPoints: -22.1,
        };
      });
      addRatedEvents(fixture.profile, 3);
      await page.goto(`/players/${playerId}`);
      const log = page.getByRole('region', { name: 'Match results' });
      await log.scrollIntoViewIfNeeded();
      await expect(log.getByRole('row', { name: /Singles bracket 2/ })).toContainText(
        'WHR ≈+30 pts',
      );
      await expect(log.getByRole('row', { name: /Singles bracket 1/ })).toContainText(
        'WHR <5 pts lower',
      );
      await expect(log.getByRole('row', { name: /Singles bracket 3/ })).toContainText(
        'WHR ≈−20 pts',
      );
      const recent = log.getByRole('row', { name: /Singles bracket 2/ });
      await expect(recent).toContainText('WHR pre-night · 32% to win');
      await expect(recent).toContainText('Less likely result');
      await expect(recent).toContainText('1.5 units');
      await expect(recent).toContainText('Margin weight 0.25');
      await expect(log.getByRole('row', { name: /Singles bracket 1/ })).toContainText(
        'First rated night',
      );
      await expect(log.getByRole('row', { name: /Singles bracket 3/ })).toContainText(
        'Separate rated groups',
      );
      await expect(log.getByRole('columnheader', { name: 'Evidence' })).toHaveCount(1);
      await expect(
        page.getByText(/up to two units total\. Evidence units weight the WHR fit/),
      ).toBeVisible();
      await expect(page.getByText(/estimates are approximate and don’t add up/)).toBeVisible();
      await expect(page.getByRole('button', { name: /WHR impact/ })).toHaveCount(0);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await log.focus();
      await expect(log).toBeFocused();
      if (width === 390) {
        await page.keyboard.press('ArrowRight');
        await expect.poll(() => log.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
        await page.keyboard.press('ArrowLeft');
        await log.evaluate((element) => {
          element.scrollLeft = 0;
        });
      }
      expect(fixture.requests).toHaveLength(3);
      await ready(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
      ).toEqual([]);
      await page.locator('.match-history').screenshot({
        path: testInfo.outputPath('whr-inline-match-log.png'),
      });
      await page.evaluate(() => scrollTo(0, 0));
      await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
      await ready(page);
      await page.screenshot({
        path: testInfo.outputPath('whr-inline-profile.png'),
        fullPage: true,
      });
    });
  }
}

test('the WHR queue waits for visible rows, paces requests and retains estimates through filtering', async ({
  page,
}) => {
  let releaseFirst!: () => void;
  const firstRequest = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let started = false;
  const fixture = await mockProfile(page, async () => {
    if (!started) {
      started = true;
      await firstRequest;
    }
    return effect;
  });
  addRatedEvents(fixture.profile, 30);
  fixture.profile.events.push({
    ...fixture.profile.events[0]!,
    seq: 30,
    isDecay: true,
    tournamentName: 'Away night',
  });
  const log = page.getByRole('region', { name: 'Match results' });
  const first = log.getByRole('row', { name: /Singles bracket 30/ });
  const oldestPool = log.getByRole('row', { name: /Singles bracket 1 / });
  const filter = page.getByRole('combobox', { name: 'Filter match history by stage' });
  try {
    await page.goto(`/players/${playerId}`);
    await expect(first).not.toBeInViewport();
    await ready(page);
    expect(fixture.requests).toHaveLength(0);
    await log.evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await expect(first).toContainText('WHR Estimating…');
    await expect(log.getByRole('row', { name: /Away night/ })).not.toContainText('WHR');
    await page.waitForTimeout(600);
    expect(fixture.requests).toHaveLength(1);
    const firstSetId = fixture.requests[0]!.setId;
    expect(firstSetId).toBe(fixture.profile.events[29]!.setId);
    expect(fixture.requests.some(({ setId }) => setId === setIds[0])).toBe(false);

    await chooseOption(filter, 'group');
    await expect(first).toHaveCount(0);
    releaseFirst();
    await expect.poll(() => fixture.requests.length).toBeGreaterThanOrEqual(4);
    const poolSets = new Set(
      fixture.profile.events
        .filter((event) => event.resultStage === 'group')
        .map((event) => event.setId),
    );
    expect(fixture.requests.slice(1).every(({ setId }) => poolSets.has(setId))).toBe(true);
    for (const [index, request] of fixture.requests.slice(1).entries())
      expect(request.at - fixture.requests[index]!.at).toBeGreaterThanOrEqual(460);
    expect(fixture.maxActive()).toBe(1);

    await expect(oldestPool).not.toBeInViewport();
    expect(fixture.requests.some(({ setId }) => setId === setIds[0])).toBe(false);
    await oldestPool.scrollIntoViewIfNeeded();
    await expect(oldestPool).toBeInViewport();
    // The rest of this viewport is also eligible and runs at two starts per second.
    await expect(oldestPool).toContainText('WHR ≈+30 pts', { timeout: 9000 });
    expect(fixture.requests.filter(({ setId }) => setId === setIds[0])).toHaveLength(1);
    await chooseOption(filter, 'all');
    await expect(first).toContainText('WHR ≈+30 pts');
    expect(fixture.requests.filter(({ setId }) => setId === firstSetId)).toHaveLength(1);
  } finally {
    releaseFirst();
  }
});

test('WHR impact distinguishes busy, changed history, small effects and load failure inline', async ({
  page,
}) => {
  const fixture = await mockProfile(page, ({ setId }) => {
    if (setId === setIds[0]) return { status: 'unavailable', reason: 'busy' };
    if (setId === setIds[1]) return { status: 'unavailable', reason: 'history_changed' };
    if (setId === fixture.profile.events[2]!.setId) return undefined;
    return { ...effect, effectPoints: 0.003 };
  });
  addRatedEvents(fixture.profile, 4);
  await page.goto(`/players/${playerId}`);
  const log = page.getByRole('region', { name: 'Match results' });
  await log.scrollIntoViewIfNeeded();
  for (const [bracket, label] of [
    [1, 'WHR Temporarily unavailable'],
    [2, 'WHR Awaiting recompute'],
    [3, 'WHR Unavailable'],
    [4, 'WHR Little change'],
  ] as const)
    await expect(
      log.getByRole('row', { name: new RegExp(`Singles bracket ${bracket}`) }),
    ).toContainText(label);
  expect(fixture.requests).toHaveLength(4);
});

test('a stale WHR run clears prior estimates and waits for the refreshed profile', async ({
  page,
}) => {
  const newRun = 'a9c935fc-1df1-4a9b-b2fc-733150e1bc4f';
  let notifyRecompute!: (body: string) => void;
  const live = new Promise<string>((resolve) => {
    notifyRecompute = resolve;
  });
  const fixture = await mockProfile(
    page,
    (request) => {
      if (request.recomputeId === newRun) return { ...effect, effectPoints: -19 };
      return request.setId === setIds[0]
        ? { status: 'unavailable', reason: 'stale_run' }
        : forecastEffect;
    },
    live,
  );
  try {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(`/players/${playerId}`);
    const log = page.getByRole('region', { name: 'Match results' });
    await log.scrollIntoViewIfNeeded();
    const recent = log.getByRole('row', { name: /Singles bracket 2/ });
    await expect(recent).toContainText('32% to win');
    await expect(recent).toContainText('WHR Refresh profile');
    await expect(recent).not.toContainText('32% to win');
    expect(fixture.requests.map(({ recomputeId }) => recomputeId)).toEqual([
      recomputeId,
      recomputeId,
    ]);
    await log.focus();
    const scrollLeft = await log.evaluate((element) => {
      element.scrollLeft = 80;
      return element.scrollLeft;
    });
    expect(scrollLeft).toBeGreaterThan(0);
    fixture.profile.recomputeId = newRun;
    notifyRecompute('event: recompute_completed\ndata: {}\n\n');
    await expect(recent).toContainText('WHR ≈−20 pts');
    await expect(recent).not.toContainText('WHR ≈+30 pts');
    expect(fixture.requests.at(-1)?.recomputeId).toBe(newRun);
    await expect(log).toBeFocused();
    expect(await log.evaluate((element) => element.scrollLeft)).toBe(scrollLeft);
  } finally {
    notifyRecompute(': fixture\n\n');
  }
});

test('a live recompute aborts the previous estimate and preserves the focused desktop scroll', async ({
  page,
}) => {
  const newRun = 'a9c935fc-1df1-4a9b-b2fc-733150e1bc4f';
  let notifyRecompute!: (body: string) => void;
  let releaseOldRequest!: () => void;
  const live = new Promise<string>((resolve) => {
    notifyRecompute = resolve;
  });
  const oldRequest = new Promise<void>((resolve) => {
    releaseOldRequest = resolve;
  });
  const fixture = await mockProfile(
    page,
    async ({ recomputeId: run }) => {
      if (run === newRun) return { ...effect, effectPoints: -19 };
      await oldRequest;
      return effect;
    },
    live,
  );
  addRatedEvents(fixture.profile, 30);
  try {
    await page.goto(`/players/${playerId}`);
    const log = page.getByRole('region', { name: 'Match results' });
    await log.evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await expect(log.getByText('WHR Estimating…')).toBeVisible();
    await log.focus();
    const scrollTop = await log.evaluate((element) => {
      element.scrollTop = 160;
      return element.scrollTop;
    });
    expect(scrollTop).toBeGreaterThan(0);
    const visibleRow = log.getByRole('row', { name: /Singles bracket 25/ });
    await expect(visibleRow).toBeInViewport({ ratio: 0.75 });
    const aborted = page.waitForEvent('requestfailed', {
      predicate: (request) =>
        request.url().includes('whrResultImpact') && request.url().includes(recomputeId),
    });
    fixture.profile.recomputeId = newRun;
    notifyRecompute('event: recompute_completed\ndata: {}\n\n');
    await aborted;
    releaseOldRequest();
    await expect(visibleRow.getByText('WHR ≈−20 pts')).toBeInViewport();
    await expect(log.getByText('WHR ≈+30 pts')).toHaveCount(0);
    await expect(log).toBeFocused();
    expect(await log.evaluate((element) => element.scrollTop)).toBe(scrollTop);
  } finally {
    releaseOldRequest();
    notifyRecompute(': fixture\n\n');
  }
});
