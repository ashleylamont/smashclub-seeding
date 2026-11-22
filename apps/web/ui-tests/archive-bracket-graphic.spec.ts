import { readFile } from 'node:fs/promises';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { knockoutMatchName } from '@smashclub/tournament-formats';
import type { LiveMatch } from '../src/lib/eventDisplay';
import type { EventOverviewData, TournamentData } from '../src/lib/apiTypes';
import { mockEvent, ready } from './fixtures';
import { bracketFixture } from '../test/fixtures/brackets';

const eventDate = '2026-10-02T08:30:00.000Z';
const eventName = 'Autumn finals';
const scope = 'Open championship';
const slug = 'archive-r2';
const alias = 'Alex & Co with an exceptionally long tournament alias from Western Sydney';
const participants = [
  { id: 'first', name: alias, finalRank: 1 },
  { id: 'second', name: 'Blair', finalRank: 2 },
  { id: 'third', name: 'Ren', finalRank: 3 },
].map((entry) => ({
  ...entry,
  challongeSeed: entry.finalRank,
  playerId: null,
  memberPlayerIds: null,
  companyCode: null,
}));

const graphicMatch = {
  nativeBracketId: 'archive',
  division: 'upper',
  stage: 'main',
  nativeRound: 1,
  nativeSlot: 0,
  status: 'complete',
  stationId: null,
  poolIndex: null,
  player1Id: 'first',
  player1Name: alias,
  player2Id: null,
  player2Name: null,
  winnerId: 'first',
  score1: null,
  score2: null,
  parent1MatchId: null,
  parent2MatchId: null,
  outcome: 'bye' as const,
};
const bracketGraphic = {
  eventName,
  eventDate,
  scope,
  revision: 2,
  format: 'singles',
  matches: [
    { ...graphicMatch, id: 'semi-a', label: 'Semi-final 1' },
    {
      ...graphicMatch,
      id: 'semi-b',
      label: 'Semi-final 2',
      nativeSlot: 1,
      player1Id: 'second',
      player1Name: 'Blair',
      player2Id: 'third',
      player2Name: 'Ren',
      winnerId: 'second',
      outcome: 'forfeit' as const,
    },
    {
      ...graphicMatch,
      id: 'final',
      label: 'Final',
      nativeRound: 2,
      parent1MatchId: 'semi-a',
      parent2MatchId: 'semi-b',
      player2Id: 'second',
      player2Name: 'Blair',
      score1: 3,
      score2: 1,
      outcome: 'played' as const,
    },
  ],
} satisfies NonNullable<TournamentData['bracketGraphic']>;
const tournament = {
  id: 'archive',
  slug,
  provider: 'native',
  competitionFormat: 'singles',
  name: `${eventName} Open Main`,
  eventDate,
  resultsMode: 'auto',
  isRookie: false,
  challongeState: 'complete',
  syncState: 'synced',
  lastSyncedAt: eventDate,
  liveUntil: null,
  participants,
  sets: bracketGraphic.matches.map((match) => ({
    id: match.id,
    round: match.nativeRound,
    identifier: match.label,
    resultStage: 'final',
    state: 'complete',
    winner: match.winnerId === match.player1Id ? 1 : 2,
    scoresCsv: match.score1 === null ? null : `${match.score1}-${match.score2}`,
    unplayedOutcome: match.outcome === 'played' ? null : match.outcome,
    excludedFromRatings: match.outcome !== 'played',
    excludedByResultsMode: false,
    completedAt: eventDate,
    p1ParticipantId: match.player1Id,
    p2ParticipantId: match.player2Id,
    p1Name: match.player1Name,
    p2Name: match.player2Name,
    p1PlayerId: null,
    p2PlayerId: null,
  })),
  bracketGraphic,
} satisfies TournamentData;
const players = participants.map((entry) => ({
  playerId: null,
  entryKey: entry.id,
  name: entry.name,
  place: entry.finalRank,
  placeSource: 'reported' as const,
  inFinalStage: true,
  wins: 1,
  losses: 0,
  poolWins: 0,
  poolLosses: 0,
  bracketWins: 1,
  bracketLosses: 0,
  provisional: false,
  tournamentId: tournament.id,
}));
const overview = {
  name: eventName,
  date: eventDate,
  canonicalSlug: slug,
  competitionFormat: 'singles',
  structure: 'single_elimination',
  divisions: [],
  brackets: [
    {
      name: tournament.name,
      slug,
      tournamentId: tournament.id,
      division: 'upper',
      stage: 'main',
      roleSource: 'plan',
      finalFieldSize: 3,
      isComplete: true,
      placeSource: 'reported',
      players,
      bracketGraphic,
    },
    {
      name: 'Unverified archive',
      slug: 'unverified',
      tournamentId: 'unverified',
      division: 'upper',
      stage: 'consolation',
      roleSource: 'plan',
      finalFieldSize: 3,
      isComplete: true,
      placeSource: 'reported',
      players,
    },
  ],
  warnings: [],
} satisfies EventOverviewData;

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test(`${theme} ${width}px archives offer downloads only for a verified bracket`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const fixture = await mockEvent(page);
      fixture.responses['public.eventOverview'] = overview;
      fixture.queryResponses.set('public.tournament', (input) => {
        if ((input as { slug: string }).slug === slug) return tournament;
        return {
          ...tournament,
          id: 'unverified',
          slug: 'unverified',
          name: 'Unverified archive',
          provider: 'challonge',
          bracketGraphic: undefined,
        };
      });
      const action = page.getByRole('button', { name: `Preview bracket graphic for ${scope}` });
      const dialog = page.getByRole('dialog', { name: 'Bracket graphic' });
      await page.goto(`/events/${slug}`);
      await expect(action).toBeVisible();
      const unverified = page.getByRole('article').filter({ hasText: 'Unverified archive' });
      await expect(unverified.getByRole('button', { name: /Preview bracket graphic/ })).toHaveCount(
        0,
      );
      await page.getByRole('button', { name: 'View bracket standings' }).first().press('Enter');
      const standings = page.getByRole('region', { name: `${tournament.name} standings` });
      await expect(standings.getByRole('cell', { name: alias })).toBeVisible();
      await page.keyboard.press('Tab');
      await expect(standings).toBeFocused();
      await ready(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath('event-archive.png'), fullPage: true });
      if (width === 390) {
        await page.keyboard.press('ArrowRight');
        await expect.poll(() => standings.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
      }

      await action.press('Enter');
      const image = dialog.getByRole('img', { name: `${eventName} · ${scope} bracket` });
      await expect(image).toBeVisible();
      await image.evaluate((img: HTMLImageElement) => img.decode());
      await expect(dialog.getByText(/Revision 2/)).toBeVisible();
      expect((await new AxeBuilder({ page }).include('.ui-dialog').analyze()).violations).toEqual(
        [],
      );
      await ready(page);
      await page.screenshot({ path: testInfo.outputPath('archive-preview.png') });
      const svgEvent = page.waitForEvent('download');
      await dialog.getByRole('button', { name: 'Download bracket SVG' }).press('Enter');
      const svg = await svgEvent;
      await svg.saveAs(testInfo.outputPath('archive.svg'));
      expect(svg.suggestedFilename()).toBe(
        'nemesis-autumn-finals-open-championship-bracket-r2.svg',
      );
      const contents = await readFile(testInfo.outputPath('archive.svg'), 'utf8');
      expect(contents).toContain('Alex &amp; Co');
      expect(contents).toContain('Forfeit');
      expect(contents).toContain('Bye');
      expect(contents).toContain('Recorded draw · Revision 2');
      expect(contents).toContain('>3</text>');
      expect(contents).toContain('>1</text>');
      await page.keyboard.press('Escape');
      await expect(action).toBeFocused();

      await page.getByRole('link', { name: tournament.name }).click();
      await expect(page).toHaveURL(`/tournaments/${slug}`);
      await expect(action).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await ready(page);
      await page.screenshot({
        path: testInfo.outputPath('tournament-archive.png'),
        fullPage: true,
      });
      await action.press('Enter');
      const pngEvent = page.waitForEvent('download');
      await dialog.getByRole('button', { name: 'Download bracket PNG' }).press('Enter');
      const png = await pngEvent;
      expect(png.suggestedFilename()).toBe(
        'nemesis-autumn-finals-open-championship-bracket-r2.png',
      );
      await png.saveAs(testInfo.outputPath('archive.png'));
      const bytes = await readFile(testInfo.outputPath('archive.png'));
      expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      await page.keyboard.press('Escape');
      await expect(action).toBeFocused();

      await page.goto('/tournaments/unverified');
      await expect(page.getByRole('heading', { name: 'Unverified archive' })).toBeVisible();
      await expect(action).toHaveCount(0);
      const importedFinal = page.getByRole('row').filter({
        has: page.getByRole('cell', { name: 'Final', exact: true }),
      });
      await expect(importedFinal.getByRole('cell').nth(1)).toHaveText('W2');
      expect(fixture.unexpected).toEqual([]);
    });

function recordedDoubleElimination(names: string[], { playReset = false } = {}) {
  const recorded = new Map<string, LiveMatch>();
  function entrantFrom(parentId: string, outcome?: 'winner' | 'loser') {
    const parent = recorded.get(parentId);
    if (!parent?.winnerId) return null;
    return outcome === 'loser'
      ? parent.winnerId === parent.player1Id
        ? parent.player2Id
        : parent.player1Id
      : parent.winnerId;
  }
  const aliasById = new Map(names.map((name, index) => [`entrant-${index}`, name]));
  return bracketFixture(names.length)
    .filter((match) => playReset || match.bracketLane !== 'reset')
    .map((match) => {
      const first = match.parent1MatchId
        ? entrantFrom(match.parent1MatchId, match.parent1Outcome)
        : match.player1Id;
      const second = match.parent2MatchId
        ? entrantFrom(match.parent2MatchId, match.parent2Outcome)
        : match.player2Id;
      const played = Boolean(first && second);
      const secondWon = playReset && match.bracketLane === 'final';
      const result = {
        ...match,
        nativeBracketId: match.nativeBracketId!,
        nativeRound: match.nativeRound!,
        nativeSlot: match.nativeSlot!,
        parent1MatchId: match.parent1MatchId ?? null,
        parent2MatchId: match.parent2MatchId ?? null,
        player1Id: first,
        player2Id: second,
        player1Name: first ? aliasById.get(first)! : null,
        player2Name: second ? aliasById.get(second)! : null,
        status: 'complete',
        outcome: played ? ('played' as const) : ('bye' as const),
        score1: played ? (secondWon ? 1 : 2) : null,
        score2: played ? (secondWon ? 2 : 0) : null,
        winnerId: secondWon ? second : (first ?? second),
      };
      recorded.set(match.id, result);
      return result;
    });
}

test('the archived double-elimination graphic names the loser route into a bye', async ({
  page,
}, testInfo) => {
  const fixture = await mockEvent(page);
  const matches = recordedDoubleElimination(participants.map(({ name }) => name));
  fixture.responses['public.eventOverview'] = {
    ...overview,
    structure: 'double_elimination',
    brackets: [{ ...overview.brackets[0], bracketGraphic: { ...bracketGraphic, matches } }],
  };

  await page.goto(`/events/${slug}`);
  await page.getByRole('button', { name: `Preview bracket graphic for ${scope}` }).press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Bracket graphic' });
  await expect(dialog.getByRole('img')).toBeVisible();
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download bracket SVG' }).press('Enter');
  const svgPath = testInfo.outputPath('double-elimination-archive.svg');
  await (await download).saveAs(svgPath);
  const exported = await page.context().newPage();
  try {
    await exported.setContent(await readFile(svgPath, 'utf8'));
    const losers = exported.getByText('losers 1 · M1 · Bye', { exact: true }).locator('..');
    await expect(losers.getByText('Bye', { exact: true })).toBeVisible();
    await expect(losers.getByText('Loser of winners 1 · M1', { exact: true })).toBeVisible();
    await expect(losers.getByText('Loser of winners 1 · M2', { exact: true })).toBeVisible();
    await exported.locator('svg').screenshot({
      path: testInfo.outputPath('double-elimination-archive.png'),
    });
  } finally {
    await exported.close();
  }

  const pngEvent = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download bracket PNG' }).press('Enter');
  await (await pngEvent).saveAs(testInfo.outputPath('double-elimination-download.png'));
  expect(fixture.unexpected).toEqual([]);
});

const doubleEliminationPlayers = [alias, 'Blair', 'Ren', 'Chris'].map((name, index) => ({
  ...participants[0]!,
  id: `entrant-${index}`,
  name,
  challongeSeed: index + 1,
  finalRank: [2, 3, 4, 1][index]!,
}));
const playedResetDraw = recordedDoubleElimination(
  doubleEliminationPlayers.map(({ name }) => name),
  { playReset: true },
).map((match) => {
  const { outcome, score1, score2 } = match;
  if (outcome !== 'played' || score1 === null || score2 === null)
    throw new Error('The four-entrant fixture must play every set.');
  const bracketLane = match.bracketLane as Parameters<typeof knockoutMatchName>[0]['bracketLane'];
  return {
    ...match,
    nativeBracketId: tournament.id,
    poolIndex: null,
    stationId: null,
    bracketLane,
    outcome,
    score1,
    score2,
    label:
      knockoutMatchName(
        {
          bracketLane,
          bracketRound: match.bracketRound,
          round: match.nativeRound,
          slot: match.nativeSlot,
        },
        doubleEliminationPlayers.length,
      ) ?? match.label,
  };
});
const doubleEliminationArchive = {
  ...tournament,
  participants: [...doubleEliminationPlayers].sort((a, b) => a.finalRank - b.finalRank),
  bracketGraphic: { ...bracketGraphic, matches: playedResetDraw },
  sets: [
    {
      ...tournament.sets[2]!,
      id: 'pool-match',
      identifier: 'Pool A · Match 4',
      resultStage: 'group',
      round: 2,
      p1ParticipantId: 'entrant-0',
      p2ParticipantId: 'entrant-1',
    },
    ...playedResetDraw.map((match) => ({
      id: match.id,
      round: match.bracketLane === 'losers' ? -match.bracketRound! : match.bracketRound!,
      identifier: match.label,
      resultStage: 'final' as const,
      state: 'complete',
      winner: match.winnerId === match.player1Id ? 1 : 2,
      scoresCsv: `${match.score1}-${match.score2}`,
      unplayedOutcome: null,
      excludedFromRatings: false,
      excludedByResultsMode: false,
      completedAt: eventDate,
      p1ParticipantId: match.player1Id,
      p2ParticipantId: match.player2Id,
      p1Name: match.player1Name,
      p2Name: match.player2Name,
      p1PlayerId: null,
      p2PlayerId: null,
    })),
  ],
} satisfies TournamentData;

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test(`${theme} ${width}px archive labels the grand final and a played reset as Finals`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const fixture = await mockEvent(page);
      fixture.queryResponses.set('public.tournament', () => doubleEliminationArchive);
      await page.goto(`/tournaments/${slug}`);
      const table = page.getByRole('region', { name: 'Tournament sets' });
      const rows = table.locator('tbody').getByRole('row');
      const grandFinal = rows.filter({
        has: page.getByRole('cell', { name: 'Grand final', exact: true }),
      });
      const reset = rows.filter({
        has: page.getByRole('cell', { name: 'Reset final (if needed)', exact: true }),
      });
      await expect(grandFinal.getByRole('cell').nth(1)).toHaveText('Finals');
      await expect(reset.getByRole('cell').nth(1)).toHaveText('Finals');
      await expect(grandFinal.getByRole('cell', { name: '1-2', exact: true })).toBeVisible();
      await expect(reset.getByRole('cell', { name: '2-0', exact: true })).toBeVisible();
      await expect(rows.locator(':scope > td:nth-child(2)')).toHaveText([
        '2',
        'W1',
        'W1',
        'L1',
        'W2',
        'L2',
        'Finals',
        'Finals',
      ]);

      await ready(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath('finals-archive.png'), fullPage: true });
      await page.getByRole('combobox', { name: 'Filter sets by stage' }).press('Tab');
      await expect(table).toBeFocused();
      await table.screenshot({ path: testInfo.outputPath('finals-round-table.png') });
      if (width === 390) {
        await page.keyboard.press('ArrowRight');
        await expect.poll(() => table.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
      }
      expect(fixture.unexpected).toEqual([]);
    });

test('an unverified legacy archive retains set labels and recorded round codes', async ({
  page,
}) => {
  const fixture = await mockEvent(page);
  fixture.queryResponses.set('public.tournament', () => ({
    ...doubleEliminationArchive,
    bracketGraphic: undefined,
    sets: doubleEliminationArchive.sets.map((set) => ({
      ...set,
      displayLabel: set.identifier,
    })),
  }));
  await page.goto(`/tournaments/${slug}`);
  const table = page.getByRole('region', { name: 'Tournament sets' });
  const grandFinal = table.getByRole('row').filter({
    has: page.getByRole('cell', { name: 'Grand final', exact: true }),
  });
  const reset = table.getByRole('row').filter({
    has: page.getByRole('cell', { name: 'Reset final (if needed)', exact: true }),
  });
  await expect(grandFinal.getByRole('cell').nth(1)).toHaveText('W3');
  await expect(reset.getByRole('cell').nth(1)).toHaveText('W3');
  expect(fixture.unexpected).toEqual([]);
});
