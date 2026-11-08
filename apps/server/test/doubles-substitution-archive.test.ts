import { expect, it } from 'vitest';
import { captureBaseline, decide, stableId } from '../src/tournament/domain';
import { reviewDoublesSubstitution } from '../src/tournament/doublesSubstitution';
import { envelope, pureBaseline } from './helpers/nativeLiveFixture';

it('protects either side of an archived finals match without blocking an unrelated pool', () => {
  const baseline = pureBaseline();
  baseline.version = 2;
  baseline.competitionFormat = 'doubles';
  baseline.structure = 'dual_division';
  for (const entrant of baseline.entrants)
    entrant.memberPlayerIds = [stableId(`${entrant.id}:a`), stableId(`${entrant.id}:b`)];
  const state = captureBaseline(baseline);
  const source = state.matches[0]!;
  const request = (playerId: string) => {
    const entrant = state.entrants.find((e) => e.playerId === playerId)!;
    return {
      entrantId: entrant.id,
      outgoingPlayerId: entrant.memberPlayerIds![1]!,
      incomingPlayerId: stableId('archive-check-substitute'),
      reason: 'Emergency substitute',
      identity: {
        name: 'Remaining / Substitute',
        oldMemberNames: ['Remaining', 'Outgoing'] as [string, string],
        newMemberNames: ['Remaining', 'Substitute'] as [string, string],
        incomingAliases: [],
      },
    };
  };
  const original = request(source.player1Id!);
  const previouslyReviewed = reviewDoublesSubstitution(state, original);
  expect(previouslyReviewed.allowed).toBe(true);

  // Production replay retains the earlier pool score as well. Isolate the
  // archive here so the direct guard cannot accidentally rely on active facts.
  state.supersededPlayedSets = [
    {
      match: {
        ...source,
        id: stableId('archive-check-match'),
        poolId: null,
        bracketId: stableId('archive-check-bracket'),
        stage: 'main',
        status: 'complete',
        started: true,
        outcome: 'played',
        score1: 2,
        score2: 1,
        winnerId: source.player1Id,
        completedAt: baseline.capturedAt + 60_000,
        resultCommandId: stableId('archive-check-result'),
      },
      replacementMatchId: stableId('archive-check-replay'),
      label: 'Superseded advancement',
      sourcePoolMatchId: source.id,
    },
  ];
  for (const id of [source.player1Id!, source.player2Id!]) {
    const input = request(id);
    const review = reviewDoublesSubstitution(state, input);
    expect(review.allowed).toBe(false);
    expect(review.issues).toEqual([
      'This pair has recorded play, a result, or a score report. Substitution is unavailable.',
    ]);
    expect(() =>
      decide(
        state,
        envelope({
          ...input,
          kind: 'substituteDoublesMember',
          revisionToken: review.revisionToken,
        }),
      ),
    ).toThrow(/recorded play/);
  }
  expect(() =>
    decide(
      state,
      envelope({
        ...original,
        kind: 'substituteDoublesMember',
        revisionToken: previouslyReviewed.revisionToken,
      }),
    ),
  ).toThrow(/changed since this preview/);
  const other = state.entrants.find((e) => e.division === 'lower')!;
  expect(reviewDoublesSubstitution(state, request(other.playerId)).allowed).toBe(true);
});
