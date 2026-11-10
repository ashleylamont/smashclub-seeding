import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { recapRankings, tournaments, type Db } from '@smashclub/db';
import { rankRecapHighlights } from '../src/recap/highlightRanking';
import type { LoadedRecap } from '../src/recap/recap';
import { createTestDb } from './helpers/testDb';

let db: Db;
let close: () => Promise<void>;
let recap: LoadedRecap;
const fetchJev = vi.fn<typeof fetch>();
const player = { playerId: null, name: 'Pair', companyCode: null, characters: [] };

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const [tournament] = await db
    .insert(tournaments)
    .values({
      challongeSlug: 'recap-fixture',
      name: 'Recap fixture',
      challongeState: 'complete',
    })
    .returning({ id: tournaments.id });
  const id = tournament!.id;
  const facts: LoadedRecap['facts'] = [
    {
      id: 'final',
      notability: 0.9,
      headline: 'Pair wins the bracket',
      detail: 'Won the final 3–2.',
      fact: {
        kind: 'grand_finals',
        tournamentId: id,
        winner: player,
        loser: player,
        score: '3-2',
        bracketReset: false,
        runSets: 4,
        gamesDropped: 2,
      },
    },
    {
      id: 'turnout',
      notability: 0.75,
      headline: 'Record turnout',
      detail: '26 entrants.',
      fact: { kind: 'turnout', tournamentId: null, entrants: 26, previousBest: 21, isRecord: true },
    },
  ];
  recap = {
    eventKey: '2026-10-10',
    name: 'Recap fixture',
    slug: 'recap-fixture',
    competitionFormat: 'doubles',
    entrants: 26,
    setsPlayed: 47,
    isComplete: true,
    isAbandoned: false,
    tournaments: [
      {
        id,
        name: 'Recap fixture',
        slug: 'recap-fixture',
        eventDate: '2026-10-10',
        isRookie: false,
        challongeState: 'complete',
      },
    ],
    facts,
    highlights: facts,
    coverage: {
      unsyncedBrackets: 0,
      unresolvedEntrants: 0,
      unlinkedPlayedSets: 0,
      ignoredGroupSets: 0,
    },
  };
  fetchJev.mockReset().mockImplementation(async () =>
    Response.json({
      model: 'jev-1.14.0',
      answers: {
        highlight_0: { type: 'score', score: 1.2 },
        highlight_1: { type: 'score', score: 2.8 },
      },
    }),
  );
  vi.stubGlobal('fetch', fetchJev);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await close();
});

it('persists one order per exact shortlist and reuses it across concurrent and later reads', async () => {
  await Promise.all([
    rankRecapHighlights(db, recap, 'fixture'),
    rankRecapHighlights(db, recap, 'fixture'),
  ]);
  const reused = await rankRecapHighlights(
    db,
    { ...recap, slug: 'alternate-event-link' },
    'fixture',
  );
  expect(reused.highlights.map((entry) => entry.id)).toEqual(['turnout', 'final']);
  expect(reused.facts).toEqual(recap.facts);
  expect(fetchJev).toHaveBeenCalledTimes(1);
  expect(await db.select().from(recapRankings)).toHaveLength(1);
  expect(JSON.parse(String(fetchJev.mock.calls[0]?.[1]?.body)).state).toEqual({
    highlights: recap.facts.map(({ fact, headline, detail }) => ({
      kind: fact.kind,
      headline,
      detail,
    })),
  });

  const [final, turnout] = recap.facts;
  await rankRecapHighlights(
    db,
    {
      ...recap,
      facts: [final!, { ...turnout!, detail: '27 entrants after a correction.' }],
    },
    'fixture',
  );
  expect(fetchJev).toHaveBeenCalledTimes(2);
  expect(await db.select().from(recapRankings)).toHaveLength(2);
});

it('keeps the deterministic order after a provider failure without re-evaluating it', async () => {
  fetchJev.mockRejectedValueOnce(new Error('provider unavailable'));
  expect(await rankRecapHighlights(db, recap, 'fixture')).toBe(recap);
  expect(await rankRecapHighlights(db, recap, 'fixture')).toBe(recap);
  expect(fetchJev).toHaveBeenCalledTimes(1);
});

it('does not rank incomplete or abandoned recaps', async () => {
  await rankRecapHighlights(db, { ...recap, isComplete: false }, 'fixture');
  await rankRecapHighlights(db, { ...recap, isAbandoned: true }, 'fixture');
  expect(fetchJev).not.toHaveBeenCalled();
  expect(await db.select().from(recapRankings)).toHaveLength(0);
});
