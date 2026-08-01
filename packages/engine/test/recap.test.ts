import { describe, expect, it } from 'vitest';
import {
  buildRecap,
  formatFact,
  pairKey,
  parseScoresCsv,
  type RecapFact,
  type RecapFactKind,
  type RecapHistory,
  type RecapInput,
  type RecapParticipant,
  type RecapSet,
  type RecapTournament,
} from '../src/recap';

/**
 * The recap turns a night into facts. Two properties matter most and are
 * covered throughout: it must produce something useful with no rating data at
 * all (identities are often still unresolved when a bracket finishes), and it
 * must never build a fact out of a DQ.
 */

const MAIN: RecapTournament = {
  id: 't-main',
  name: 'Club Night 12',
  eventDate: '2025-03-01T08:00:00.000Z',
  isRookie: false,
  challongeState: 'complete',
};

let seq = 0;
function participant(overrides: Partial<RecapParticipant> & { name: string }): RecapParticipant {
  seq += 1;
  return {
    id: `p-${overrides.name.toLowerCase().replace(/\W+/g, '')}-${seq}`,
    tournamentId: MAIN.id,
    playerId: `player-${overrides.name.toLowerCase().replace(/\W+/g, '')}`,
    companyCode: null,
    characters: [],
    seed: null,
    finalRank: null,
    ...overrides,
  };
}

let setSeq = 0;
function completedSet(
  p1: RecapParticipant,
  p2: RecapParticipant,
  winner: 1 | 2,
  overrides: Partial<RecapSet> = {},
): RecapSet {
  setSeq += 1;
  return {
    id: `s-${setSeq}`,
    tournamentId: MAIN.id,
    round: 1,
    identifier: String(setSeq),
    state: 'complete',
    p1ParticipantId: p1.id,
    p2ParticipantId: p2.id,
    winner,
    scoresCsv: '3-0',
    excludedFromRatings: false,
    completedAt: `2025-03-01T09:0${setSeq % 10}:00.000Z`,
    ...overrides,
  };
}

/** Facts of one kind, for concise assertions. */
function factsOfKind<K extends RecapFactKind>(
  result: ReturnType<typeof buildRecap>,
  kind: K,
): Array<Extract<RecapFact, { kind: K }>> {
  return result.facts
    .map((f) => f.fact)
    .filter((f): f is Extract<RecapFact, { kind: K }> => f.kind === kind);
}

function emptyHistory(overrides: Partial<RecapHistory> = {}): RecapHistory {
  return {
    priorSetCounts: new Map(),
    priorEventCounts: new Map(),
    priorPeakRating: new Map(),
    priorMeetings: new Map(),
    ...overrides,
  };
}

describe('parseScoresCsv', () => {
  it('reads a single pair as the set score', () => {
    expect(parseScoresCsv('3-1')).toEqual({ p1: 3, p2: 1, unknown: false });
  });

  it('tallies games won when scores are reported per game', () => {
    // "1-0,0-1,1-0" is three games, two of them to player 1.
    expect(parseScoresCsv('1-0,0-1,1-0')).toEqual({ p1: 2, p2: 1, unknown: false });
  });

  it('ignores games that were drawn when tallying', () => {
    expect(parseScoresCsv('2-0,1-1,0-2,3-1')).toEqual({ p1: 2, p2: 1, unknown: false });
  });

  it('treats a forfeit as unreadable rather than as a scoreline', () => {
    // Challonge marks forfeits with a negative score; there is no game story.
    expect(parseScoresCsv('-1-0').unknown).toBe(true);
  });

  it('treats missing or malformed scores as unknown', () => {
    expect(parseScoresCsv(null).unknown).toBe(true);
    expect(parseScoresCsv('').unknown).toBe(true);
    expect(parseScoresCsv('W/O').unknown).toBe(true);
  });
});

describe('pairKey', () => {
  it('is order independent', () => {
    expect(pairKey('b', 'a')).toBe(pairKey('a', 'b'));
  });
});

describe('buildRecap without any rating data', () => {
  const champion = participant({ name: 'Ivy', seed: 6, finalRank: 1 });
  const runnerUp = participant({ name: 'Nour', seed: 1, finalRank: 2 });
  const third = participant({ name: 'Sam', seed: 2, finalRank: 3 });

  const input: RecapInput = {
    tournaments: [MAIN],
    participants: [champion, runnerUp, third],
    sets: [
      completedSet(champion, third, 1, { round: 2 }),
      completedSet(champion, runnerUp, 1, { round: 3, scoresCsv: '3-2' }),
    ],
  };

  it('still produces facts', () => {
    // The whole point: a bracket that just finished has no recompute yet.
    expect(buildRecap(input).facts.length).toBeGreaterThan(0);
  });

  it('reports the podium in placing order', () => {
    const [podium] = factsOfKind(buildRecap(input), 'podium');
    expect(podium?.places.map((p) => p.player.name)).toEqual(['Ivy', 'Nour', 'Sam']);
    expect(podium?.places[0]?.seed).toBe(6);
  });

  it('finds the seed upset', () => {
    const upsets = factsOfKind(buildRecap(input), 'seed_upset');
    expect(upsets.map((u) => [u.winner.name, u.loser.name])).toContainEqual(['Ivy', 'Nour']);
  });

  it('emits no rating-derived facts', () => {
    const result = buildRecap(input);
    expect(factsOfKind(result, 'rating_upset')).toHaveLength(0);
    expect(factsOfKind(result, 'biggest_climb')).toHaveLength(0);
  });

  it('calls the last set of the bracket grand finals', () => {
    const [finals] = factsOfKind(buildRecap(input), 'grand_finals');
    expect(finals?.winner.name).toBe('Ivy');
    expect(finals?.bracketReset).toBe(false);
    expect(finals?.score).toBe('3-2');
  });
});

describe('placements when Challonge reports none', () => {
  /*
   * The default sync source is the embedded bracket page, which carries no
   * final_rank at all — so this path, not the reported one, is what most of the
   * club's history goes through.
   */
  const champ = participant({ name: 'Ivy', seed: 3 });
  const runnerUp = participant({ name: 'Nour', seed: 1 });
  const third = participant({ name: 'Sam', seed: 2 });

  /** A double-elimination bracket with nobody's final_rank filled in. */
  const bracket: RecapSet[] = [
    completedSet(champ, third, 1, { round: 1, completedAt: '2025-03-01T09:00:00.000Z' }),
    // Sam beats Nour in losers, so Nour is out third.
    completedSet(third, runnerUp, 1, { round: -1, completedAt: '2025-03-01T09:30:00.000Z' }),
    completedSet(champ, third, 1, { round: 2, completedAt: '2025-03-01T10:00:00.000Z' }),
  ];

  it('derives the podium from elimination order', () => {
    const result = buildRecap({
      tournaments: [MAIN],
      participants: [champ, runnerUp, third],
      sets: bracket,
    });
    const [podium] = factsOfKind(result, 'podium');
    // Last eliminated placed best: Ivy undefeated, then Sam, then Nour.
    expect(podium?.places.map((p) => [p.player.name, p.place])).toEqual([
      ['Ivy', 1],
      ['Sam', 2],
      ['Nour', 3],
    ]);
  });

  it('marks a derived podium as derived', () => {
    const derivedResult = buildRecap({
      tournaments: [MAIN],
      participants: [champ, runnerUp, third],
      sets: bracket,
    });
    expect(factsOfKind(derivedResult, 'podium')[0]?.derived).toBe(true);

    const reportedResult = buildRecap({
      tournaments: [MAIN],
      participants: [
        { ...champ, finalRank: 1 },
        { ...runnerUp, finalRank: 2 },
        { ...third, finalRank: 3 },
      ],
      sets: bracket,
    });
    expect(factsOfKind(reportedResult, 'podium')[0]?.derived).toBe(false);
  });

  it('prefers what Challonge reported over what the bracket implies', () => {
    // The API path is authoritative when it is available.
    const result = buildRecap({
      tournaments: [MAIN],
      participants: [
        { ...champ, finalRank: 1 },
        { ...runnerUp, finalRank: 2 },
        { ...third, finalRank: 3 },
      ],
      sets: bracket,
    });
    expect(factsOfKind(result, 'podium')[0]?.places.map((p) => p.player.name)).toEqual([
      'Ivy',
      'Nour',
      'Sam',
    ]);
  });

  it('derives nothing while the bracket is still underway', () => {
    const result = buildRecap({
      tournaments: [{ ...MAIN, challongeState: 'underway' }],
      participants: [champ, runnerUp, third],
      sets: bracket,
    });
    expect(factsOfKind(result, 'podium')).toHaveLength(0);
  });

  it('derives nothing when more than one player is unbeaten', () => {
    // Two unbeaten players means there is no single champion to anchor the
    // ordering on, so any podium read off it would be a guess.
    const a = participant({ name: 'Una' });
    const b = participant({ name: 'Vex' });
    const c = participant({ name: 'Wren' });
    const result = buildRecap({
      tournaments: [MAIN],
      participants: [a, b, c],
      sets: [completedSet(a, c, 1), completedSet(b, c, 1)],
    });
    expect(factsOfKind(result, 'podium')).toHaveLength(0);
  });

  it('does not claim a seed overperformance from a derived placement', () => {
    // Derived placements are exact at the top and approximate below it, so
    // "seeded 3rd, finished 2nd" is not a number worth publishing.
    const result = buildRecap({
      tournaments: [MAIN],
      participants: [champ, runnerUp, third],
      sets: bracket,
    });
    expect(factsOfKind(result, 'overperformer')).toHaveLength(0);
  });

  it('still finds the champion for a clean sweep', () => {
    const opponents = [participant({ name: 'Bo' }), participant({ name: 'Cy' }), participant({ name: 'Di' })];
    const sweeper = participant({ name: 'Ada' });
    const result = buildRecap({
      tournaments: [MAIN],
      participants: [sweeper, ...opponents],
      sets: opponents.map((o, i) =>
        completedSet(sweeper, o, 1, { scoresCsv: '3-0', completedAt: `2025-03-01T0${i + 1}:00:00.000Z` }),
      ),
    });
    expect(factsOfKind(result, 'clean_sweep')[0]?.player.name).toBe('Ada');
  });
});

describe('excluded sets', () => {
  it('never become facts', () => {
    const winner = participant({ name: 'Ada', seed: 9 });
    const loser = participant({ name: 'Bo', seed: 1 });
    const result = buildRecap({
      tournaments: [MAIN],
      participants: [winner, loser],
      // A DQ that would otherwise read as a huge seed upset.
      sets: [completedSet(winner, loser, 1, { excludedFromRatings: true, scoresCsv: '-1-0' })],
    });
    expect(factsOfKind(result, 'seed_upset')).toHaveLength(0);
    expect(result.setsPlayed).toBe(0);
  });

  it('do not break a clean sweep claim for the sets that were played', () => {
    // A walkover is not a dropped game, but it is also not evidence of one.
    const champion = participant({ name: 'Ada', finalRank: 1 });
    const a = participant({ name: 'Bo' });
    const b = participant({ name: 'Cy' });
    const c = participant({ name: 'Di' });
    const result = buildRecap({
      tournaments: [MAIN],
      participants: [champion, a, b, c],
      sets: [
        completedSet(champion, a, 1),
        completedSet(champion, b, 1),
        completedSet(champion, c, 1),
        completedSet(champion, c, 1, { excludedFromRatings: true, scoresCsv: '-1-0' }),
      ],
    });
    expect(factsOfKind(result, 'clean_sweep')).toHaveLength(1);
  });
});

describe('clean sweeps', () => {
  const champion = participant({ name: 'Ada', finalRank: 1 });
  const others = [participant({ name: 'Bo' }), participant({ name: 'Cy' }), participant({ name: 'Di' })];

  it('are claimed when no game was dropped', () => {
    const result = buildRecap({
      tournaments: [MAIN],
      participants: [champion, ...others],
      sets: others.map((o) => completedSet(champion, o, 1, { scoresCsv: '3-0' })),
    });
    const [sweep] = factsOfKind(result, 'clean_sweep');
    expect(sweep?.player.name).toBe('Ada');
    expect(sweep?.sets).toBe(3);
  });

  it('are not claimed when a game was dropped', () => {
    const sets = others.map((o) => completedSet(champion, o, 1, { scoresCsv: '3-0' }));
    sets[1] = { ...sets[1]!, scoresCsv: '3-1' };
    const result = buildRecap({ tournaments: [MAIN], participants: [champion, ...others], sets });
    expect(factsOfKind(result, 'clean_sweep')).toHaveLength(0);
  });

  it('are not claimed when a scoreline could not be read', () => {
    // An unreadable score could be hiding a dropped game, so the sweep is
    // unverifiable and must not be asserted.
    const sets = others.map((o) => completedSet(champion, o, 1, { scoresCsv: '3-0' }));
    sets[2] = { ...sets[2]!, scoresCsv: null };
    const result = buildRecap({ tournaments: [MAIN], participants: [champion, ...others], sets });
    expect(factsOfKind(result, 'clean_sweep')).toHaveLength(0);
  });
});

describe('nailbiters', () => {
  it('are sets that went to a deciding game', () => {
    const a = participant({ name: 'Ada' });
    const b = participant({ name: 'Bo' });
    const result = buildRecap({
      tournaments: [MAIN],
      participants: [a, b],
      sets: [completedSet(a, b, 1, { scoresCsv: '3-2' })],
    });
    const [fact] = factsOfKind(result, 'nailbiter');
    expect(fact?.score).toBe('3-2');
  });

  it('report the score from the winner\'s side even when player two won', () => {
    const a = participant({ name: 'Ada' });
    const b = participant({ name: 'Bo' });
    const result = buildRecap({
      tournaments: [MAIN],
      participants: [a, b],
      // scores_csv is always player-one-first, so "2-3" is a win for Bo.
      sets: [completedSet(a, b, 2, { scoresCsv: '2-3' })],
    });
    const [fact] = factsOfKind(result, 'nailbiter');
    expect(fact?.winner.name).toBe('Bo');
    expect(fact?.score).toBe('3-2');
  });

  it('exclude one-sided sets', () => {
    const a = participant({ name: 'Ada' });
    const b = participant({ name: 'Bo' });
    const result = buildRecap({
      tournaments: [MAIN],
      participants: [a, b],
      sets: [completedSet(a, b, 1, { scoresCsv: '3-0' })],
    });
    expect(factsOfKind(result, 'nailbiter')).toHaveLength(0);
  });
});

describe('losers runs', () => {
  it('count consecutive elimination wins', () => {
    const runner = participant({ name: 'Ada', finalRank: 2 });
    const opponents = [1, 2, 3, 4].map((n) => participant({ name: `Foe${n}` }));
    const result = buildRecap({
      tournaments: [MAIN],
      participants: [runner, ...opponents],
      sets: opponents.map((o, i) => completedSet(runner, o, 1, { round: -(i + 1) })),
    });
    const [run] = factsOfKind(result, 'losers_run');
    expect(run?.wins).toBe(4);
    expect(run?.finalRank).toBe(2);
  });

  it('ignore short runs', () => {
    const runner = participant({ name: 'Ada' });
    const opponents = [1, 2].map((n) => participant({ name: `Foe${n}` }));
    const result = buildRecap({
      tournaments: [MAIN],
      participants: [runner, ...opponents],
      sets: opponents.map((o, i) => completedSet(runner, o, 1, { round: -(i + 1) })),
    });
    expect(factsOfKind(result, 'losers_run')).toHaveLength(0);
  });
});

describe('grand finals', () => {
  it('detect a bracket reset from two sets in the final round', () => {
    const a = participant({ name: 'Ada', finalRank: 1 });
    const b = participant({ name: 'Bo', finalRank: 2 });
    const result = buildRecap({
      tournaments: [MAIN],
      participants: [a, b],
      sets: [
        completedSet(a, b, 2, { round: 5, completedAt: '2025-03-01T10:00:00.000Z' }),
        completedSet(a, b, 1, { round: 5, completedAt: '2025-03-01T10:30:00.000Z' }),
      ],
    });
    const [finals] = factsOfKind(result, 'grand_finals');
    expect(finals?.bracketReset).toBe(true);
    // The decider is the later set — Ada won the reset.
    expect(finals?.winner.name).toBe('Ada');
  });

  it('are not claimed for a bracket still in progress', () => {
    const a = participant({ name: 'Ada' });
    const b = participant({ name: 'Bo' });
    const result = buildRecap({
      tournaments: [{ ...MAIN, challongeState: 'underway' }],
      participants: [a, b],
      sets: [completedSet(a, b, 1, { round: 2 })],
    });
    expect(factsOfKind(result, 'grand_finals')).toHaveLength(0);
    expect(result.isComplete).toBe(false);
  });
});

describe('rating-derived facts', () => {
  const underdog = participant({ name: 'Ada' });
  const favourite = participant({ name: 'Bo' });
  const set = completedSet(underdog, favourite, 1, { round: 3 });

  const result = buildRecap({
    tournaments: [MAIN],
    participants: [underdog, favourite],
    sets: [set],
    ratingEvents: [
      {
        playerId: underdog.playerId!,
        setId: set.id,
        tournamentId: MAIN.id,
        isDecay: false,
        won: true,
        preRating: 1300,
        postRating: 1360,
        preRd: 80,
        postRd: 75,
      },
      {
        playerId: favourite.playerId!,
        setId: set.id,
        tournamentId: MAIN.id,
        isDecay: false,
        won: false,
        preRating: 1800,
        postRating: 1740,
        preRd: 60,
        postRd: 58,
      },
    ],
  });

  it('score the upset by how unlikely it was', () => {
    const [upset] = factsOfKind(result, 'rating_upset');
    expect(upset?.winner.name).toBe('Ada');
    expect(upset?.probability).toBeLessThan(0.2);
    expect(Math.round(upset!.ratingGap)).toBe(500);
  });

  it('report the biggest climb of the night', () => {
    const [climb] = factsOfKind(result, 'biggest_climb');
    expect(climb?.player.name).toBe('Ada');
    expect(Math.round(climb!.gained)).toBe(60);
  });

  it('do not call an even set an upset', () => {
    const a = participant({ name: 'Cy' });
    const b = participant({ name: 'Di' });
    const even = completedSet(a, b, 1);
    const evenResult = buildRecap({
      tournaments: [MAIN],
      participants: [a, b],
      sets: [even],
      ratingEvents: [a, b].map((p, i) => ({
        playerId: p.playerId!,
        setId: even.id,
        tournamentId: MAIN.id,
        isDecay: false,
        won: i === 0,
        preRating: 1500,
        postRating: 1500 + (i === 0 ? 12 : -12),
        preRd: 60,
        postRd: 59,
      })),
    });
    expect(factsOfKind(evenResult, 'rating_upset')).toHaveLength(0);
  });
});

describe('history-derived facts', () => {
  const a = participant({ name: 'Ada' });
  const b = participant({ name: 'Bo' });
  const set = completedSet(a, b, 1);

  it('report a rivalry with the series to the night\'s winner', () => {
    const prior = { aWins: 3, bWins: 3 };
    const result = buildRecap({
      tournaments: [MAIN],
      participants: [a, b],
      sets: [set],
      history: emptyHistory({
        priorMeetings: new Map([[pairKey(a.playerId!, b.playerId!), prior]]),
      }),
    });
    const [rivalry] = factsOfKind(result, 'rivalry');
    expect(rivalry?.meetings).toBe(7);
    // `a` is always tonight's winner, and their win is already counted.
    expect(rivalry?.a.name).toBe('Ada');
    expect([rivalry?.aWins, rivalry?.bWins]).toEqual([4, 3]);
  });

  it('ignore a pairing that has barely met', () => {
    const result = buildRecap({
      tournaments: [MAIN],
      participants: [a, b],
      sets: [set],
      history: emptyHistory({
        priorMeetings: new Map([[pairKey(a.playerId!, b.playerId!), { aWins: 1, bWins: 0 }]]),
      }),
    });
    expect(factsOfKind(result, 'rivalry')).toHaveLength(0);
  });

  it('announce debuts for players with no prior nights', () => {
    const result = buildRecap({
      tournaments: [MAIN],
      participants: [a, b],
      sets: [set],
      history: emptyHistory({ priorEventCounts: new Map([[a.playerId!, 4]]) }),
    });
    const [debut] = factsOfKind(result, 'debut');
    expect(debut?.players.map((p) => p.name)).toEqual(['Bo']);
  });

  it('report a career-high rating only against a known previous peak', () => {
    const withPeak = buildRecap({
      tournaments: [MAIN],
      participants: [a, b],
      sets: [set],
      ratingEvents: [
        {
          playerId: a.playerId!,
          setId: set.id,
          tournamentId: MAIN.id,
          isDecay: false,
          won: true,
          preRating: 1500,
          postRating: 1560,
          preRd: 60,
          postRd: 58,
        },
      ],
      history: emptyHistory({ priorPeakRating: new Map([[a.playerId!, 1520]]) }),
    });
    const peaks = factsOfKind(withPeak, 'milestone').filter((m) => m.milestone === 'peak_rating');
    expect(peaks.map((p) => p.player.name)).toEqual(['Ada']);

    // With no prior peak recorded, that is a debut rather than a career high.
    const noHistory = buildRecap({
      tournaments: [MAIN],
      participants: [a, b],
      sets: [set],
      ratingEvents: [
        {
          playerId: a.playerId!,
          setId: set.id,
          tournamentId: MAIN.id,
          isDecay: false,
          won: true,
          preRating: 1500,
          postRating: 1560,
          preRd: 60,
          postRd: 58,
        },
      ],
      history: emptyHistory(),
    });
    expect(factsOfKind(noHistory, 'milestone').filter((m) => m.milestone === 'peak_rating')).toHaveLength(0);
  });

  it('mark a round-number career set count crossed tonight', () => {
    const result = buildRecap({
      tournaments: [MAIN],
      participants: [a, b],
      sets: [set],
      history: emptyHistory({ priorSetCounts: new Map([[a.playerId!, 49]]) }),
    });
    const milestones = factsOfKind(result, 'milestone').filter((m) => m.milestone === 'sets');
    expect(milestones.map((m) => [m.player.name, m.value])).toEqual([['Ada', 50]]);
  });
});

describe('the night as a whole', () => {
  it('folds both brackets of an evening into one recap', () => {
    const rookie: RecapTournament = {
      id: 't-rookie',
      name: 'Club Night 12 (Rookie)',
      eventDate: '2025-03-01T10:00:00.000Z',
      isRookie: true,
      challongeState: 'complete',
    };
    const mainPlayer = participant({ name: 'Ada', finalRank: 1 });
    const rookiePlayer = participant({ name: 'Bo', tournamentId: rookie.id, finalRank: 1 });
    const rookieFoe = participant({ name: 'Cy', tournamentId: rookie.id, finalRank: 2 });

    const result = buildRecap({
      tournaments: [rookie, MAIN],
      participants: [mainPlayer, rookiePlayer, rookieFoe],
      sets: [completedSet(rookiePlayer, rookieFoe, 1, { tournamentId: rookie.id })],
    });

    // Main bracket first — a night's headline result is the main bracket's.
    expect(result.tournaments.map((t) => t.id)).toEqual([MAIN.id, rookie.id]);
    expect(result.eventKey).toBe('2025-03-01');
    expect(factsOfKind(result, 'podium')).toHaveLength(2);
  });

  it('counts a player who entered both brackets once in the turnout', () => {
    const rookie: RecapTournament = { ...MAIN, id: 't-rookie', isRookie: true };
    const inMain = participant({ name: 'Ada' });
    const inRookie = { ...inMain, id: 'other-entry', tournamentId: rookie.id };
    const result = buildRecap({
      tournaments: [MAIN, rookie],
      participants: [inMain, inRookie],
      sets: [],
      priorTurnouts: [{ eventKey: '2025-02-01', entrants: 1 }],
    });
    const [turnout] = factsOfKind(result, 'turnout');
    expect(turnout?.entrants).toBe(1);
  });

  it('only compares turnout when there is a previous night to compare with', () => {
    const result = buildRecap({
      tournaments: [MAIN],
      participants: [participant({ name: 'Ada' })],
      sets: [],
    });
    expect(factsOfKind(result, 'turnout')).toHaveLength(0);
  });

  it('ranks facts by notability, most notable first', () => {
    const champion = participant({ name: 'Ivy', seed: 8, finalRank: 1 });
    const foe = participant({ name: 'Nour', seed: 1, finalRank: 2 });
    const result = buildRecap({
      tournaments: [MAIN],
      participants: [champion, foe],
      sets: [completedSet(champion, foe, 1, { round: 4 })],
    });
    const scores = result.facts.map((f) => f.notability);
    expect(scores).toEqual([...scores].sort((x, y) => y - x));
  });

  it('is empty but well-formed for a night with nothing in it', () => {
    const result = buildRecap({ tournaments: [], participants: [], sets: [] });
    expect(result).toMatchObject({ facts: [], entrants: 0, setsPlayed: 0, isComplete: false });
  });
});

describe('formatFact', () => {
  it('writes copy for every fact kind', () => {
    // A missing branch would ship a blank card, so every kind is exercised.
    const player = { playerId: 'x', name: 'Ada', companyCode: 'ACME', characters: [] };
    const other = { playerId: 'y', name: 'Bo', companyCode: null, characters: [] };
    const facts: RecapFact[] = [
      { kind: 'podium', tournamentId: 't', derived: false, places: [{ player, place: 1, seed: 3 }, { player: other, place: 2, seed: 1 }] },
      { kind: 'seed_upset', tournamentId: 't', winner: player, loser: other, winnerSeed: 8, loserSeed: 1, round: 2, score: '3-1' },
      { kind: 'rating_upset', tournamentId: 't', winner: player, loser: other, probability: 0.12, ratingGap: 320, round: -3, score: '3-2' },
      { kind: 'losers_run', tournamentId: 't', player, wins: 5, finalRank: 2 },
      { kind: 'overperformer', tournamentId: 't', player, seed: 12, finalRank: 4, placesGained: 8 },
      { kind: 'nailbiter', tournamentId: 't', winner: player, loser: other, score: '3-2', round: 4 },
      { kind: 'clean_sweep', tournamentId: 't', player, sets: 5 },
      { kind: 'biggest_climb', tournamentId: 't', player, gained: 62.4, from: 1500, to: 1562.4 },
      { kind: 'mover', tournamentId: null, player, rank: 7, previousRank: 11, placesGained: 4 },
      { kind: 'rivalry', tournamentId: 't', a: player, b: other, meetings: 7, aWins: 4, bWins: 3 },
      { kind: 'debut', tournamentId: 't', players: [player] },
      { kind: 'milestone', tournamentId: 't', player, milestone: 'sets', value: 100 },
      { kind: 'milestone', tournamentId: 't', player, milestone: 'peak_rating', value: 1712.8 },
      { kind: 'turnout', tournamentId: null, entrants: 24, previousBest: 21, isRecord: true },
      { kind: 'grand_finals', tournamentId: 't', winner: player, loser: other, score: '3-2', bracketReset: true },
    ];

    for (const fact of facts) {
      const { headline, detail } = formatFact(fact);
      expect(headline, `headline for ${fact.kind}`).not.toBe('');
      expect(headline, `headline for ${fact.kind}`).not.toContain('undefined');
      expect(detail, `detail for ${fact.kind}`).not.toContain('undefined');
      expect(detail, `detail for ${fact.kind}`).not.toContain('NaN');
    }

    /*
     * Adding a fact kind without a sample above should fail here rather than
     * ship a blank card. The Record key type makes it a *compile* error, which
     * is the only check that cannot be forgotten — a runtime count would just
     * need bumping.
     */
    const covered: Record<RecapFactKind, boolean> = {
      podium: false, seed_upset: false, rating_upset: false, losers_run: false,
      overperformer: false, nailbiter: false, clean_sweep: false, biggest_climb: false,
      mover: false, rivalry: false, debut: false, milestone: false, turnout: false,
      grand_finals: false,
    };
    for (const fact of facts) covered[fact.kind] = true;
    expect(Object.entries(covered).filter(([, seen]) => !seen).map(([kind]) => kind)).toEqual([]);
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
        round: 1,
        score: null,
      }).detail;

    expect(seedUpset(2, 1)).toContain('2nd seed over the 1st');
    expect(seedUpset(23, 3)).toContain('23rd seed over the 3rd');
    // The teens are the case a naive suffix table gets wrong.
    expect(seedUpset(13, 11)).toContain('13th seed over the 11th');
  });
});
