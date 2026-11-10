import { describe, expect, it } from 'vitest';
import { formatFact, type RecapFact, type RecapFactKind } from '../src/recap';

describe('formatFact', () => {
  it('writes copy for every fact kind', () => {
    // A missing branch would ship a blank card, so every kind is exercised.
    const player = { playerId: 'x', name: 'Ada', companyCode: 'ACME', characters: [] };
    const other = { playerId: 'y', name: 'Bo', companyCode: null, characters: [] };
    const facts: RecapFact[] = [
      {
        kind: 'podium',
        tournamentId: 't',
        derived: false,
        places: [
          { player, place: 1, seed: 3 },
          { player: other, place: 2, seed: 1 },
        ],
      },
      {
        kind: 'seed_upset',
        tournamentId: 't',
        winner: player,
        loser: other,
        winnerSeed: 8,
        loserSeed: 1,
        stage: 'the winners final',
        score: '3-1',
      },
      {
        kind: 'rating_upset',
        tournamentId: 't',
        winner: player,
        loser: other,
        probability: 0.12,
        ratingGap: 320,
        stage: 'the losers semis',
        score: '3-2',
      },
      { kind: 'losers_run', tournamentId: 't', player, wins: 5, finalRank: 2 },
      { kind: 'overperformer', tournamentId: 't', player, seed: 12, finalRank: 4, placesGained: 8 },
      {
        kind: 'nailbiter',
        tournamentId: 't',
        winner: player,
        loser: other,
        score: '3-2',
        stage: null,
      },
      { kind: 'runback', tournamentId: 't', winner: player, loser: other, score: '2-1' },
      { kind: 'clean_sweep', tournamentId: 't', player, sets: 5 },
      { kind: 'biggest_climb', tournamentId: 't', player, gained: 62.4, from: 1500, to: 1562.4 },
      { kind: 'mover', tournamentId: null, player, rank: 7, previousRank: 11, placesGained: 4 },
      { kind: 'rivalry', tournamentId: 't', a: player, b: other, meetings: 7, aWins: 4, bWins: 3 },
      {
        kind: 'breakthrough',
        tournamentId: 't',
        winner: player,
        loser: other,
        priorLosses: 4,
        stage: 'the losers final',
        score: '2-1',
      },
      { kind: 'debut', tournamentId: 't', players: [player] },
      { kind: 'milestone', tournamentId: 't', player, milestone: 'sets', value: 100 },
      { kind: 'milestone', tournamentId: 't', player, milestone: 'peak_rating', value: 1712.8 },
      { kind: 'turnout', tournamentId: null, entrants: 24, previousBest: 21, isRecord: true },
      {
        kind: 'grand_finals',
        tournamentId: 't',
        winner: player,
        loser: other,
        score: '3-2',
        bracketReset: true,
        runSets: 6,
        gamesDropped: 4,
      },
    ];

    for (const fact of facts) {
      const { headline, detail } = formatFact(fact);
      expect(headline, `headline for ${fact.kind}`).not.toBe('');
      expect(headline, `headline for ${fact.kind}`).not.toContain('undefined');
      expect(detail, `detail for ${fact.kind}`).not.toContain('undefined');
      expect(detail, `detail for ${fact.kind}`).not.toContain('NaN');
    }

    const pair = { playerId: null, name: 'Pair A', companyCode: null, characters: [] };
    const poolFacts: RecapFact[] = [
      {
        kind: 'pool_tie',
        tournamentId: null,
        teams: [pair, { ...pair, name: 'Pair B' }, { ...pair, name: 'Pair C' }],
        setWins: 1,
        circular: true,
        splitFinals: true,
      },
      { kind: 'pool_sweep', tournamentId: null, player: pair, wins: 3 },
      { kind: 'pool_deciders', tournamentId: null, closeSets: 5, totalSets: 6 },
    ];
    for (const fact of poolFacts) expect(formatFact(fact).headline.length).toBeGreaterThan(0);

    /*
     * Adding a fact kind without a sample above should fail here rather than
     * ship a blank card. The Record key type makes it a *compile* error, which
     * is the only check that cannot be forgotten — a runtime count would just
     * need bumping.
     */
    const covered: Record<RecapFactKind, boolean> = {
      pool_tie: false,
      pool_sweep: false,
      pool_deciders: false,
      podium: false,
      seed_upset: false,
      rating_upset: false,
      losers_run: false,
      overperformer: false,
      nailbiter: false,
      clean_sweep: false,
      biggest_climb: false,
      mover: false,
      rivalry: false,
      breakthrough: false,
      debut: false,
      milestone: false,
      turnout: false,
      grand_finals: false,
      runback: false,
    };
    for (const fact of [...facts, ...poolFacts]) covered[fact.kind] = true;
    expect(
      Object.entries(covered)
        .filter(([, seen]) => !seen)
        .map(([kind]) => kind),
    ).toEqual([]);
  });

  it('uses the right ordinal suffixes', () => {
    const player = { playerId: 'x', name: 'Ada', companyCode: null, characters: [] };
    const other = { playerId: 'y', name: 'Bo', companyCode: null, characters: [] };
    const seedUpset = (winnerSeed: number, loserSeed: number): string =>
      formatFact({
        kind: 'seed_upset',
        tournamentId: 't',
        winner: player,
        loser: other,
        winnerSeed,
        loserSeed,
        stage: null,
        score: null,
      }).detail;

    expect(seedUpset(2, 1)).toContain('2nd seed against the 1st');
    expect(seedUpset(23, 3)).toContain('23rd seed against the 3rd');
    // The teens are the case a naive suffix table gets wrong.
    expect(seedUpset(13, 11)).toContain('13th seed against the 11th');
  });
});
