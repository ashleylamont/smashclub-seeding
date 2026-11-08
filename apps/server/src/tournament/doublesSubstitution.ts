import { isKnockout } from '@smashclub/shared';
import { memberIds } from './entrants';
import { hash, requireFact, resolved, unconfirmedCall } from './facts';
import { qualifierFieldFrozen } from './qualifiers';
import type { TournamentCommand, TournamentState } from './schemas';

type Command = Extract<TournamentCommand, { kind: 'substituteDoublesMember' }>;
export type DoublesSubstitution = Omit<Command, 'kind' | 'revisionToken'>;

export function reviewDoublesSubstitution(state: TournamentState, input: DoublesSubstitution) {
  const { entrantId, outgoingPlayerId, incomingPlayerId, identity, reason } = input;
  const entrant = state.entrants.find((item) => item.id === entrantId);
  const pools = state.pools.filter((pool) => entrant && pool.entrantIds.includes(entrant.playerId));
  const pool = pools.length === 1 ? pools[0] : undefined;
  const members = entrant ? memberIds(entrant) : [];
  const incomingIds = new Set([incomingPlayerId, ...(identity?.incomingAliases ?? [])]);
  const incomingEntered = state.entrants.some((item) =>
    memberIds(item).some((playerId) => incomingIds.has(playerId)),
  );
  const matches = state.matches.filter(
    (match) => entrant && [match.player1Id, match.player2Id].includes(entrant.playerId),
  );
  const reported = new Set(state.reports.map((report) => report.matchId));
  const finalsFrozen = pool ? qualifierFieldFrozen(state, pool.division) : false;
  const calls = matches.filter(unconfirmedCall).map((match) => match.id);
  const issues: string[] = [];

  if (
    state.baseline?.competitionFormat !== 'doubles' ||
    isKnockout(state.baseline.structure) ||
    (state.lifecycle !== 'locked' && state.lifecycle !== 'unlocked')
  )
    issues.push('Substitutions require an open, soft-locked native doubles event with pools.');
  if (!entrant || entrant.availability === 'withdrawn' || members.length !== 2 || !pool)
    issues.push('Choose a pair currently assigned to a pool.');
  if (!members.includes(outgoingPlayerId))
    issues.push('The outgoing player is no longer in this pair.');
  if (!identity) issues.push('Choose an active registered substitute.');
  if (incomingEntered) issues.push('The substitute already has an entry in this event.');
  if (
    finalsFrozen ||
    pool?.order ||
    pool?.orderDecision ||
    pool?.qualifierRoster ||
    pool?.qualifierDecision
  )
    issues.push('This pool’s qualification has already been confirmed or used.');
  if (
    !matches.length ||
    matches.some((match) => match.poolId !== pool?.id || match.stage !== 'group')
  )
    issues.push('The pair must have only scheduled matches in its own pool.');
  if (
    matches.some(
      (match) =>
        match.started ||
        resolved(match) ||
        match.outcome !== null ||
        match.score1 !== null ||
        match.score2 !== null ||
        match.liveScore1 !== null ||
        match.liveScore2 !== null ||
        match.progressRevision !== 0 ||
        match.completedAt !== null ||
        match.automaticFromRevision !== null ||
        match.resultCommandId !== null ||
        match.winnerId !== null ||
        reported.has(match.id),
    )
  )
    issues.push(
      'This pair has recorded play, a result, or a score report. Substitution is unavailable.',
    );
  if (calls.length || matches.some((match) => match.calledAt != null))
    issues.push('Return the pair’s untaken calls before reviewing this substitution.');

  return {
    entrant,
    pool,
    matches,
    allowed: issues.length === 0,
    issues,
    returnCallMatchIds: issues.length === 1 ? calls : [],
    revisionToken: hash({
      entrant,
      pool: pool && [
        pool.id,
        pool.entrantIds,
        pool.order,
        pool.orderDecision,
        pool.qualifierRoster,
        pool.qualifierDecision,
      ],
      lifecycle: state.lifecycle,
      finalsFrozen,
      matches,
      reported: matches.filter((match) => reported.has(match.id)).map((match) => match.id),
      incomingEntered,
      outgoingPlayerId,
      incomingPlayerId,
      identity,
      reason,
    }),
  };
}

export function substituteDoublesMember(
  state: TournamentState,
  input: Command,
  basis: Record<string, number>,
) {
  const preview = reviewDoublesSubstitution(state, input);
  requireFact(
    preview.revisionToken === input.revisionToken,
    'The pair changed since this preview. Review the substitution again.',
  );
  requireFact(preview.allowed && preview.entrant && input.identity, preview.issues.join(' '));

  const { entrant, matches } = preview;
  basis[entrant.id] = entrant.revision;
  entrant.memberPlayerIds = memberIds(entrant).map((playerId) =>
    playerId === input.outgoingPlayerId ? input.incomingPlayerId : playerId,
  );
  if (entrant.memberAvailability) delete entrant.memberAvailability[input.outgoingPlayerId];
  entrant.name = input.identity.name;
  entrant.memberSubstituted = true;
  // The assigned pool seed remains fixed. A different pair cannot inherit the
  // original pair's frozen strength. Future finals use the existing no-rating prior.
  entrant.snapshotRank = null;
  entrant.snapshotScore = null;
  entrant.snapshotMean = null;
  entrant.snapshotSd = null;
  entrant.revision++;
  for (const match of matches) {
    basis[match.id] = match.revision;
    match.revision++;
  }
  state.settings.resourceRevision++;
}
