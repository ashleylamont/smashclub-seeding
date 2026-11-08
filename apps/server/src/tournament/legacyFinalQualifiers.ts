import { standardBracketOrder } from '@smashclub/tournament-formats';
import { nativeBracketDraw } from '../event-operations/nativeBracketDraw';
import { requireFact, resolved } from './facts';
import { qualifierDependencies, qualifierKey, rollingFinals } from './qualifiers';
import type { Match, QualifierSource, TournamentBaseline, TournamentState } from './schemas';

type Bracket = TournamentState['brackets'][number];
type Pool = TournamentState['pools'][number];

const sides = [
  { player: 'player1Id', qualifier: 'player1Qualifier' },
  { player: 'player2Id', qualifier: 'player2Qualifier' },
] as const;
const pendingPattern = /^pending:(upper|lower):(0|[1-9]\d*):([1-9]\d*)$/;
export const legacyPendingRosterMessage =
  'This pool has reserved finals places. Confirm its finishing order before changing its active roster.';

function activeEntrants(state: Pick<TournamentState, 'entrants'>, pool: Pool, order: string[]) {
  const withdrawn = new Set(
    state.entrants
      .filter((entrant) => entrant.availability === 'withdrawn')
      .map(({ playerId }) => playerId),
  );
  return order.filter((id) => pool.entrantIds.includes(id) && !withdrawn.has(id));
}

function assertOpenSide(match: Match, reportIds: ReadonlySet<string>) {
  requireFact(
    !match.started &&
      !resolved(match) &&
      match.status !== 'playing' &&
      match.score1 === null &&
      match.score2 === null &&
      match.liveScore1 === null &&
      match.liveScore2 === null &&
      !reportIds.has(match.id),
    `Legacy finals match ${match.id} has a pending qualifier and recorded play or report history.`,
  );
}

function setQualificationBlocks(matches: Match[]) {
  for (const match of matches) {
    const blocks = qualifierDependencies({ matches }, match).filter(
      (source) => source.status !== 'resolved',
    );
    if (blocks.length) match.qualificationBlocks = blocks;
    else delete match.qualificationBlocks;
  }
}

function assertLegacyTree(bracket: Bracket, matches: Match[], drawSize: number) {
  const position = (round: number, slot: number) => `${round}:${slot}`;
  const positions = new Map(matches.map((match) => [position(match.round, match.slot), match]));
  const message = `Legacy finals bracket ${bracket.id} has invalid match positions or feeders.`;
  requireFact(matches.length === drawSize - 1 && positions.size === matches.length, message);
  for (let width = drawSize / 2, round = 1; width >= 1; width /= 2, round++) {
    for (let slot = 0; slot < width; slot++) {
      const match = positions.get(position(round, slot));
      const parent1Id = positions.get(position(round - 1, slot * 2))?.id ?? null;
      const parent2Id = positions.get(position(round - 1, slot * 2 + 1))?.id ?? null;
      requireFact(
        match &&
          match.division === bracket.division &&
          match.stage === bracket.stage &&
          match.sourceKey === `native:${bracket.division}:${bracket.stage}:${round}:${slot}` &&
          match.parent1Id === parent1Id &&
          match.parent2Id === parent2Id,
        message,
      );
    }
  }
}

/** Old SQL stored unresolved seed references in entrantIds. Bind them to their
 * original first-round sides. Fixed seeds stay as players without a qualifier
 * source, so confirming a pool can never turn them into movable places.
 * The journal already persists these match fields in imports and decisions. */
export function importLegacyFinalQualifiers(
  baseline: TournamentBaseline,
  sqlBrackets: readonly Pick<Bracket, 'id' | 'division' | 'stage' | 'entrantIds'>[],
  reports: readonly Pick<TournamentState['reports'][number], 'matchId'>[],
) {
  const brackets = sqlBrackets.map(({ id, division, stage, entrantIds }) => ({
    id,
    division,
    stage,
    entrantIds,
  }));
  if (!brackets.some((bracket) => bracket.entrantIds.some((id) => id.startsWith('pending:'))))
    return { brackets, matches: baseline.matches };

  const reportIds = new Set(reports.map(({ matchId }) => matchId));
  const matches = baseline.matches.map((match) => ({ ...match }));
  const entrants = new Set(baseline.entrants.map(({ playerId }) => playerId));
  const seen = new Set<string>();
  const imported = brackets.map((bracket) => {
    if (!bracket.entrantIds.some((id) => id.startsWith('pending:'))) return bracket;
    const bracketMatches = matches.filter((match) => match.bracketId === bracket.id);
    const firstRound = bracketMatches.filter((match) => match.round === 1);
    requireFact(
      new Set(bracket.entrantIds).size === bracket.entrantIds.length,
      `Legacy finals bracket ${bracket.id} has duplicate seeds.`,
    );
    const slots = nativeBracketDraw(bracket.entrantIds);
    assertLegacyTree(bracket, bracketMatches, slots.length);
    for (const match of firstRound) {
      for (const [side, { player, qualifier }] of sides.entries()) {
        const seed = slots[match.slot * 2 + side]!;
        if (!seed?.startsWith('pending:')) {
          requireFact(
            (seed === null || entrants.has(seed)) && match[player] === seed,
            `Legacy finals match ${match.id} disagrees with its stored seed.`,
          );
          continue;
        }

        const parts = pendingPattern.exec(seed);
        const poolIndex = Number(parts?.[2]);
        const place = Number(parts?.[3]);
        const pool = baseline.pools.find(
          (entry) => entry.division === parts?.[1] && entry.index === poolIndex,
        );
        requireFact(
          pool &&
            pool.division === bracket.division &&
            pool.order === null &&
            Number.isSafeInteger(place) &&
            place <= activeEntrants(baseline, pool, pool.entrantIds).length &&
            !seen.has(seed),
          `Legacy finals bracket ${bracket.id} has invalid or duplicate qualifier ${seed}.`,
        );
        requireFact(
          match[player] === null,
          `Legacy finals match ${match.id} already has a player in a pending slot.`,
        );
        seen.add(seed);
        match[qualifier] = {
          poolId: pool.id,
          poolIndex,
          division: pool.division,
          place,
          status: 'pending',
        };
      }
    }
    setQualificationBlocks(bracketMatches);
    for (const match of bracketMatches) {
      if (!match.qualificationBlocks?.length) continue;
      assertOpenSide(match, reportIds);
      requireFact(
        match.status === 'blocked',
        `Legacy finals match ${match.id} is not blocked while awaiting qualification.`,
      );
    }
    return {
      ...bracket,
      entrantIds: bracket.entrantIds.filter((id) => !id.startsWith('pending:')),
    };
  });
  return { brackets: imported, matches };
}

export function hasLegacyQualifier(
  state: TournamentState,
  poolId: string,
  status: 'pending' | 'resolved',
) {
  return (
    !rollingFinals(state) &&
    state.matches.some(
      (match) =>
        match.bracketId &&
        sides.some(({ qualifier }) => {
          const source = match[qualifier];
          return source?.poolId === poolId && source.status === status;
        }),
    )
  );
}

/** Confirm only the reserved places belonging to the submitted pool orders.
 * Reconstruct entrants from persisted first-round sides in legacy seed order. */
export function resolveLegacyFinalQualifiers(
  state: TournamentState,
  poolIds: readonly string[],
  basis: Record<string, number>,
) {
  const orders = new Map(
    state.pools
      .filter((pool) => poolIds.includes(pool.id) && pool.order)
      .map((pool) => [pool.id, activeEntrants(state, pool, pool.order!)]),
  );
  const reportIds = new Set(state.reports.map(({ matchId }) => matchId));
  const affected = new Set<string>();
  for (const match of state.matches) {
    if (!match.bracketId) continue;
    let changed = false;
    for (const { player, qualifier } of sides) {
      const source = match[qualifier];
      if (!source || source.status !== 'pending') continue;
      const order = orders.get(source.poolId);
      if (!order) continue;
      const entrantId = order[source.place - 1];
      requireFact(entrantId, 'The active pool roster no longer fills its reserved finals places.');
      requireFact(
        !state.brackets.some(
          (bracket) => bracket.id !== match.bracketId && bracket.entrantIds.includes(entrantId),
        ),
        'A legacy qualification would enter the same player in two finals brackets.',
      );
      assertOpenSide(match, reportIds);
      requireFact(match[player] === null, 'A legacy qualifier would change an existing opponent.');
      match[player] = entrantId;
      match[qualifier] = { ...source, status: 'resolved' };
      changed = true;
    }
    if (changed) {
      basis[match.id] ??= match.revision;
      match.revision++;
      affected.add(match.bracketId);
    }
  }

  const updated = state.brackets
    .filter(({ id }) => affected.has(id))
    .map((bracket) => {
      const matches = state.matches.filter((match) => match.bracketId === bracket.id);
      setQualificationBlocks(matches);
      for (const match of matches) {
        if (
          !match.qualificationBlocks?.length &&
          match.blockedReason === 'Waiting for pool finishing order'
        )
          match.blockedReason = null;
      }
      const seeds = firstRoundSeeds(matches);
      requireFact(
        new Set(seeds).size === seeds.length,
        'A legacy qualification would enter the same player twice.',
      );
      bracket.entrantIds = seeds;
      return matches;
    });
  if (updated.length) state.settings.resourceRevision++;
  return updated;
}

function firstRoundSeeds(matches: Match[]) {
  const firstRound = matches.filter((match) => match.round === 1);
  const order = standardBracketOrder(firstRound.length * 2);
  const seeds: (string | null)[] = [];
  for (const match of firstRound) {
    seeds[order[match.slot * 2]! - 1] = match.player1Id;
    seeds[order[match.slot * 2 + 1]! - 1] = match.player2Id;
  }
  return seeds.filter((id): id is string => id !== null);
}

export function legacyQualifierSlots(state: TournamentState, matches: Match[]) {
  if (rollingFinals(state)) return [];
  const sources = new Map<string, { source: QualifierSource; entrantId: string | null }>();
  for (const match of matches)
    for (const { player, qualifier } of sides) {
      const source = match[qualifier];
      if (source) sources.set(qualifierKey(source), { source, entrantId: match[player] });
    }
  return [...sources.values()].map(({ source, entrantId }) => {
    const pool = state.pools.find(({ id }) => id === source.poolId)!;
    return {
      ...source,
      entrantId,
      eligibleEntrantIds: activeEntrants(state, pool, pool.entrantIds),
    };
  });
}
