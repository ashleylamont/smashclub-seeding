import { advance } from './brackets';
import { available } from './entrants';
import { dispatchAvailability } from './dispatch';
import { completeCommandProgression } from './progression';
import { hash, requireFact, resolved, stableId } from './facts';
import { hasCurrentPendingScoreReview } from './scoreReview';
import type { CommandEnvelope, Match, TournamentState } from './schemas';

const withdrawalHold = 'Player withdrawn: awaiting organiser forfeit decision';

export function restorationToken(state: TournamentState, playerId: string, reason: string) {
  return hash({
    action: 'restore',
    playerId,
    reason: reason.trim(),
    entrants: state.entrants,
    pools: state.pools,
    matches: state.matches,
    reports: state.reports,
    brackets: state.brackets,
    lifecycle: state.lifecycle,
    settings: state.settings,
    stations: state.stations,
  });
}

/** Presence is restored. Recorded results and frozen qualifier membership are
 * never undone. Started or manually held pairings require their existing controls. */
export function restoreEntrant(
  state: TournamentState,
  envelope: CommandEnvelope,
  playerId: string,
) {
  const entrant = state.entrants.find((e) => e.playerId === playerId);
  requireFact(entrant?.availability === 'withdrawn', 'Choose a currently withdrawn entrant.');
  entrant.availability = 'available';
  entrant.revision++;
  const resumed: Match[] = [];
  for (const match of state.matches.filter((m) => [m.player1Id, m.player2Id].includes(playerId))) {
    if (!resolved(match) && match.status === 'blocked' && match.blockedReason === withdrawalHold) {
      if (match.started)
        match.blockedReason =
          'Actual play is retained; an organiser must resume this original pairing.';
      else if (match.held)
        match.blockedReason = 'The organiser hold remains after attendance restoration.';
      else {
        match.blockedReason = null;
        resumed.push(match);
      }
    }
  }
  advance(state, envelope.at, envelope.id);
  for (const match of resumed)
    if (match.status === 'ready' && !hasCurrentPendingScoreReview(match, state.reports))
      match.revision++;
  state.settings.resourceRevision++;
}

function matchEffect(state: TournamentState, match: Match) {
  const name = (id: string | null) =>
    state.entrants.find((e) => e.playerId === id)?.name ?? 'Awaiting opponent';
  const base = {
    id: match.id,
    label: match.label,
    player1Name: name(match.player1Id),
    player2Name: name(match.player2Id),
    status: match.status,
    outcome: match.outcome,
  };
  if (resolved(match))
    return {
      ...base,
      effect: 'retained' as const,
      reason:
        match.outcome === 'played'
          ? 'Played result stays recorded.'
          : `Recorded ${match.outcome?.replaceAll('_', ' ') ?? 'result'} stays in place. Changing that recorded outcome needs a separate organiser ruling.`,
    };
  if (match.started)
    return {
      ...base,
      effect: match.status === 'blocked' ? ('ruling' as const) : ('existing' as const),
      reason:
        match.status === 'blocked'
          ? 'Actual play and the original pairing stay recorded. The held match must be resumed through its TO match controls.'
          : 'The existing actual-play pairing is retained; attendance restoration does not create a new match or undo its progress.',
    };
  const reasons = dispatchAvailability(state, match).reasons.filter(
    (reason) => reason.code !== 'capacity_full',
  );
  if (reasons.length)
    return { ...base, effect: 'waiting' as const, reason: reasons.map((r) => r.message).join(' ') };
  return {
    ...base,
    effect: 'resumable' as const,
    reason:
      'This unplayed pairing can resume, subject to the usual station, capacity and call checks.',
  };
}

export function previewRestoration(state: TournamentState, playerId: string, reason = '') {
  const entrant = state.entrants.find((e) => e.playerId === playerId);
  const pool = state.pools.find((p) => p.entrantIds.includes(playerId));
  const issues: string[] = [];
  if (!['locked', 'unlocked'].includes(state.lifecycle))
    issues.push('Attendance changes require an open locked event.');
  if (entrant?.availability !== 'withdrawn') issues.push('Choose a currently withdrawn entrant.');
  if (!reason.trim()) issues.push('Give a reason for restoring this entrant.');
  const next = structuredClone(state);
  if (!issues.length) {
    const id = stableId(`restore-preview:${state.baseline!.planId}:${playerId}`);
    const command: CommandEnvelope = {
      id,
      requestId: id,
      actorId: 'restoration-preview',
      operator: true,
      at: Date.now(),
      command: {
        kind: 'attendance',
        action: 'restore',
        playerId,
        reason: reason.trim(),
        revisionToken: restorationToken(state, playerId, reason),
        approveRedistribution: false,
      },
    };
    restoreEntrant(next, command, playerId);
    completeCommandProgression(state, next, command, {});
  }
  const effects = next.matches
    .filter((m) => [m.player1Id, m.player2Id].includes(playerId))
    .map((m) => matchEffect(next, m));
  const frozen = pool?.qualifierRoster;
  const qualification = frozen
    ? {
        status: frozen.includes(playerId)
          ? ('frozen_included' as const)
          : ('frozen_excluded' as const),
        reason: frozen.includes(playerId)
          ? 'The frozen finals field is unchanged. Only existing reserved places can apply; recorded outcomes and used routes remain fixed.'
          : 'This entrant was excluded when the finals field was frozen. Restoration does not add a finals place, reseed or change the recorded draw.',
      }
    : {
        status: pool && !state.brackets.length ? ('unfrozen' as const) : ('fixed_draw' as const),
        reason:
          pool && !state.brackets.length
            ? 'This entrant is eligible for a future finals draw, subject to the confirmed pool order. Prior results and tie rulings stay recorded.'
            : 'The existing draw, used qualifiers and recorded outcomes stay fixed. Restoration does not add a finals place or put an eliminated entrant back into the bracket.',
      };
  const waitingMembers = entrant && !available(next.entrants.find((e) => e.id === entrant.id)!);
  return {
    allowed: !issues.length,
    issues,
    warnings: [
      'Restoration keeps player/team identity, played results, forfeits, byes and no-contests. It does not reverse a result or repair a downstream draw.',
      ...(waitingMembers ? ['An entrant or team-member availability hold still applies.'] : []),
      ...(!effects.some((effect) => effect.effect === 'resumable')
        ? [
            'No new match becomes ready from this restoration. Review the waiting matches and retained results below.',
          ]
        : []),
    ],
    requiresExternalAcknowledgement: false,
    requiresRedistributionApproval: false,
    relocations: [],
    division: entrant?.division ?? 'lower',
    poolIndex: pool?.index ?? null,
    poolSize: pool?.entrantIds.length ?? 0,
    addedMatches: 0,
    affectedMatches: effects.map(({ id, label, status }) => ({ id, label, status })),
    restoration: {
      effects,
      qualification,
      slots: next.brackets.flatMap((b) =>
        (b.qualifierSlots ?? []).filter((s) => s.poolId === pool?.id),
      ),
    },
    revisionToken: restorationToken(state, playerId, reason),
  };
}
