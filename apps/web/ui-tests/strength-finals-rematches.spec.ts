import { readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import {
  buildEliminationTree,
  FINALS_POOL_PLACE_COST,
  knockoutMatchName,
  poolRematchRounds,
  seedFinalistsByStrength,
  seedPoolFinishers,
  type ConsolationBracket,
} from '@smashclub/tournament-formats';
import type { trpc } from '../src/lib/trpc';
import { bracketCaptureOptions, mockEvent, PLAN_ID, ready } from './fixtures';

type Preview = Awaited<ReturnType<typeof trpc.eventOps.native.preview.query>>;
type StrengthPreview = Extract<Preview, { seedPolicy: 'pool_place_whr_v1' }>;
type Fixture = Awaited<ReturnType<typeof mockEvent>>;

function finalsFixture(
  fixture: Fixture,
  division: 'upper' | 'lower',
  poolPlaces: readonly string[],
  fromEntrant: number,
): StrengthPreview['brackets'][number] {
  const id = `${division}-finals`;
  const field = poolPlaces.map((poolPlace, index) => {
    const entrant = fixture.snapshot.entrants[fromEntrant + index]!;
    const poolIndex = poolPlace.charCodeAt(0) - 'A'.charCodeAt(0);
    const place = Number(poolPlace.slice(1));
    return {
      playerId: entrant.id,
      poolIndex,
      place,
      strength: 2000 - 55 * index + FINALS_POOL_PLACE_COST * (place - 1),
    };
  });
  const combined = seedFinalistsByStrength(field);
  const poolPlacesOnly = seedPoolFinishers(field);
  const compare = (draw: ConsolationBracket) => ({
    byes: draw.roundOne.filter(({ b }) => !b).map(({ a }) => a.playerId),
    rematchesByRound: poolRematchRounds(draw),
  });
  const qualifierSlots = combined.seeds.map(({ playerId, poolIndex, place }) => ({
    poolId: `${division}-pool-${poolIndex}`,
    poolIndex,
    division,
    place,
    status: 'resolved' as const,
    entrantId: playerId,
    eligibleEntrantIds: field
      .filter((row) => row.poolIndex === poolIndex)
      .map((row) => row.playerId),
  }));
  const previewMatches = buildEliminationTree(
    id,
    combined.entrants.map(({ playerId }) => ({ kind: 'entrant', entrantId: playerId })),
  ).map((match) => {
    const [a, b] = match.sides;
    const player1Id = a.kind === 'entrant' ? a.entrantId : null;
    const player2Id = b.kind === 'entrant' ? b.entrantId : null;
    const bye = a.kind === 'bye' || b.kind === 'bye';
    return {
      ...fixture.snapshot.matches[0]!,
      id: match.id,
      division,
      stage: 'main' as const,
      label:
        knockoutMatchName(match, field.length) ?? `Round ${match.round} · Match ${match.slot + 1}`,
      nativeBracketId: id,
      nativeRound: match.round,
      nativeSlot: match.slot,
      parent1MatchId: match.dependsOn[0] ?? null,
      parent2MatchId: match.dependsOn[1] ?? null,
      player1Id,
      player2Id,
      status: bye
        ? ('complete' as const)
        : player1Id && player2Id
          ? ('ready' as const)
          : ('blocked' as const),
      outcome: bye ? ('bye' as const) : null,
      winnerId: bye ? (player1Id ?? player2Id) : null,
      score1: null,
      score2: null,
      stationId: null,
      called: false,
      callLocation: null,
      poolIndex: null,
      syncState: 'local' as const,
      sourceSetId: null,
      eventPlanId: PLAN_ID,
      resultUpdatedAt: null,
    };
  });
  return {
    id,
    division,
    stage: 'main',
    entrantIds: combined.entrants.map(({ playerId }) => playerId),
    alreadyDrawn: false,
    qualifierSlots,
    roundOne: previewMatches.filter(({ nativeRound }) => nativeRound === 1),
    previewMatches,
    strengthSeeding: {
      policy: 'pool_place_whr_v1',
      poolPlaceCost: FINALS_POOL_PLACE_COST,
      seeds: combined.seeds.map((seed) => ({
        ...seed,
        strengthSource: 'frozen',
        poolPlaceSeed: poolPlacesOnly.entrants.find(({ playerId }) => playerId === seed.playerId)!
          .bracketSeed,
      })),
      comparison: { poolPlaces: compare(poolPlacesOnly), combined: compare(combined) },
    },
  };
}

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test(`${theme} ${width}px explains forced finals rematches in the seeding preview`, async ({
      page,
    }, testInfo) => {
      const fixture = await mockEvent(page, { role: 'admin' });
      fixture.snapshot.entrants[7]!.name = 'Aster with a long tournament alias and partner';
      fixture.snapshot.entrants[8]!.name = 'Blaze with another long tournament alias and partner';
      Object.assign(fixture.snapshot.plan, { bracketMode: 'native', structure: 'dual_division' });
      const upper = finalsFixture(
        fixture,
        'upper',
        ['A1', 'B1', 'C1', 'A2', 'B2', 'C2', 'C3', 'A3', 'A4'],
        0,
      );
      const lower = finalsFixture(fixture, 'lower', ['A1', 'A2', 'A3', 'A4'], 9);
      const preview: StrengthPreview = {
        seedPolicy: 'pool_place_whr_v1',
        existing: false,
        allowed: true,
        issues: [],
        replacing: false,
        resetAllowed: false,
        resetIssues: ['No finals exist.'],
        resetBracketIds: [],
        resetCallMatchIds: [],
        divisionResets: [],
        resetRevisionToken: 'reset-token',
        revisionToken: 'draw-token',
        poolOrders: [],
        waitingStages: [],
        brackets: [upper, lower],
      };
      fixture.responses['eventOps.native.preview'] = preview;
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      await page.goto(`/operate/${PLAN_ID}?view=draw`);
      await page.getByRole('button', { name: 'Preview finals', exact: true }).press('Enter');
      const compare = page.getByRole('button', { name: 'Compare seeding and byes' });
      const regions = page.getByRole('region', { name: 'Finals seeding comparison' });
      await expect(compare).toHaveCount(2);
      for (let index = 0; index < 2; index++) {
        await compare.nth(index).press('Enter');
        await page.keyboard.press('Tab');
        await expect(regions.nth(index)).toBeFocused();
      }
      await expect(
        page.getByText(
          'The 7 fixed byes leave two entrants in the opening round. Both came from the same pool, so their rematch is unavoidable.',
        ),
      ).toBeVisible();
      await expect(
        page.getByText('All qualifiers came from one pool, so every opening match is a rematch.'),
      ).toBeVisible();
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
      await page.screenshot({
        path: testInfo.outputPath(`finals-rematch-explanations-${theme}-${width}.png`),
        fullPage: true,
        style: readFileSync(bracketCaptureOptions.stylePath, 'utf8'),
      });
      if (theme === 'light' && width === 1440) {
        delete upper.qualifierSlots;
        await page.getByRole('button', { name: 'Preview finals', exact: true }).press('Enter');
        await expect(
          page.getByText('The combined draw retains 1 opening-round pool rematch.'),
        ).toBeVisible();
        await expect(page.getByText('their rematch is unavoidable.', { exact: false })).toHaveCount(
          0,
        );
      }
      expect(fixture.unexpected).toEqual([]);
    });
