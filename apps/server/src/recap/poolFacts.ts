import type { RankedRecapFact, RecapPlayerRef } from '@smashclub/engine';
import type { Match, TournamentResult } from '../tournament/schemas';

type PoolMatch = Pick<
  Match,
  | 'stage'
  | 'poolId'
  | 'skipped'
  | 'status'
  | 'outcome'
  | 'player1Id'
  | 'player2Id'
  | 'winnerId'
  | 'score1'
  | 'score2'
>;
type Contest = PoolMatch & { player1Id: string; player2Id: string; winnerId: string };
type PoolEvidence = Pick<TournamentResult, 'competitionFormat' | 'poolOrders'> & {
  matches: readonly PoolMatch[];
  brackets: Pick<TournamentResult['brackets'][number], 'stage' | 'entrantIds'>[];
};

export function nativeDoublesPoolFacts(
  result: PoolEvidence,
  names: ReadonlyMap<string, RecapPlayerRef>,
): RankedRecapFact[] {
  if (result.competitionFormat !== 'doubles' || !result.poolOrders?.length) return [];
  const pools = new Map<string, PoolMatch[]>();
  for (const match of result.matches) {
    if (match.stage !== 'group' || !match.poolId || match.skipped) continue;
    const pool = pools.get(match.poolId) ?? [];
    pool.push(match);
    pools.set(match.poolId, pool);
  }
  const championship = new Set(
    result.brackets
      .filter((bracket) => bracket.stage === 'main')
      .flatMap((bracket) => bracket.entrantIds),
  );
  const consolation = new Set(
    result.brackets
      .filter((bracket) => bracket.stage === 'consolation')
      .flatMap((bracket) => bracket.entrantIds),
  );
  const facts: RankedRecapFact[] = [];
  for (const [poolId, matches] of pools) {
    const played = matches.filter(
      (match): match is Contest =>
        match.status === 'complete' &&
        (match.outcome === 'played' || match.outcome === 'forfeit') &&
        match.player1Id !== null &&
        match.player2Id !== null &&
        match.player1Id !== match.player2Id &&
        (match.winnerId === match.player1Id || match.winnerId === match.player2Id),
    );
    if (played.length !== matches.length) continue;
    const members = new Set(played.flatMap((match) => [match.player1Id, match.player2Id]));
    const pairings = new Set(
      played.map((match) => [match.player1Id, match.player2Id].sort().join(':')),
    );
    if (
      members.size < 3 ||
      pairings.size !== played.length ||
      pairings.size !== (members.size * (members.size - 1)) / 2
    )
      continue;
    const orders = result.poolOrders.filter(
      ({ order }) =>
        order.length === members.size &&
        new Set(order).size === members.size &&
        order.every((id) => members.has(id) && names.has(id)),
    );
    if (orders.length !== 1) continue;
    const order = orders[0]!.order;
    const wins = new Map(
      order.map((id) => [id, played.filter((match) => match.winnerId === id).length]),
    );
    for (const setWins of new Set(wins.values())) {
      const tied = order.filter((id) => wins.get(id) === setWins);
      const splitFinals =
        tied.some((id) => championship.has(id)) && tied.some((id) => consolation.has(id));
      if (tied.length < 3 && !(tied.length === 2 && splitFinals)) continue;
      const mutual = played.filter(
        (match) => tied.includes(match.player1Id) && tied.includes(match.player2Id),
      );
      const circular =
        tied.length === 3 &&
        mutual.every((match) => match.outcome === 'played') &&
        tied.every((id) => mutual.filter((match) => match.winnerId === id).length === 1);
      facts.push({
        id: `pool-tie:${poolId}:${setWins}`,
        notability: splitFinals ? 0.91 : 0.72,
        fact: {
          kind: 'pool_tie',
          tournamentId: null,
          teams: tied.map((id) => names.get(id)!),
          setWins,
          circular,
          splitFinals,
        },
      });
    }

    const best = order.find((id) => wins.get(id) === members.size - 1);
    if (
      best &&
      members.size >= 4 &&
      played.filter((match) => match.winnerId === best).every((match) => match.outcome === 'played')
    ) {
      facts.push({
        id: `pool-sweep:${poolId}`,
        notability: 0.58,
        fact: {
          kind: 'pool_sweep',
          tournamentId: null,
          player: names.get(best)!,
          wins: members.size - 1,
        },
      });
    }

    const scored = played.filter(
      ({ outcome, score1, score2 }) => outcome === 'played' && score1 !== null && score2 !== null,
    );
    const close = scored.filter(({ score1, score2 }) => Math.abs(score1! - score2!) === 1);
    if (
      scored.length === played.length &&
      close.length >= 3 &&
      close.length * 4 >= scored.length * 3
    ) {
      facts.push({
        id: `pool-deciders:${poolId}`,
        notability: 0.64,
        fact: {
          kind: 'pool_deciders',
          tournamentId: null,
          closeSets: close.length,
          totalSets: scored.length,
        },
      });
    }
  }
  return facts;
}
