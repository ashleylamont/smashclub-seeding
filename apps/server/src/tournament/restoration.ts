import { advance } from './brackets';
import { available } from './entrants';
import { dispatchAvailability } from './dispatch';
import { completeCommandProgression } from './progression';
import { qualifierFieldFrozen } from './qualifiers';
import { hasLegacyQualifier, legacyPendingRosterMessage } from './legacyFinalQualifiers';
import { hash, requireFact, resolved, stableId } from './facts';
import { hasCurrentPendingScoreReview } from './scoreReview';
import { projectMatchLabels } from './matchNames';
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

function matchEffect(state: TournamentState, match: Match, label: string) {
  const name = (id: string | null) =>
    state.entrants.find((e) => e.playerId === id)?.name ?? 'Awaiting opponent';
  const base = {
    id: match.id,
    label,
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
          : `Recorded ${match.outcome?.replaceAll('_', ' ') ?? 'result'} stays in place. Changing it needs a separate organiser ruling.`,
    };
  if (match.started)
    return {
      ...base,
      effect: match.status === 'blocked' ? ('ruling' as const) : ('existing' as const),
      reason:
        match.status === 'blocked'
          ? 'Actual play and the original pairing stay recorded. Resume it through the TO match controls.'
          : 'The original pairing and its progress stay recorded.',
    };
  const reasons = dispatchAvailability(state, match).reasons.filter(
    (reason) => reason.code !== 'capacity_full',
  );
  if (reasons.length)
    return { ...base, effect: 'waiting' as const, reason: reasons.map((r) => r.message).join(' ') };
  return {
    ...base,
    effect: 'resumable' as const,
    reason: 'Can resume after the usual station, capacity and call checks.',
  };
}

export function previewRestoration(state: TournamentState, playerId: string, reason = '') {
  const entrant = state.entrants.find((e) => e.playerId === playerId);
  const pool = state.pools.find((p) => p.entrantIds.includes(playerId));
  const issues: string[] = [];
  if (!['locked', 'unlocked'].includes(state.lifecycle))
    issues.push('Attendance changes require an open locked event.');
  if (entrant?.availability !== 'withdrawn') issues.push('Choose a currently withdrawn entrant.');
  if (pool && hasLegacyQualifier(state, pool.id, 'pending'))
    issues.push(legacyPendingRosterMessage);
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
  const labels = projectMatchLabels(next);
  const effects = next.matches
    .filter((m) => [m.player1Id, m.player2Id].includes(playerId))
    .map((m) => matchEffect(next, m, labels.get(m.id)?.label ?? m.label));
  const frozen = pool?.qualifierRoster;
  const awaitingDraw = pool && !qualifierFieldFrozen(state, pool.division);
  const qualification = frozen
    ? {
        status: frozen.includes(playerId)
          ? ('frozen_included' as const)
          : ('frozen_excluded' as const),
        reason: frozen.includes(playerId)
          ? 'The frozen finals field and used routes stay fixed. Only existing reserved places can apply.'
          : 'This entrant was excluded when the finals field was frozen. The frozen field and existing draw stay fixed.',
      }
    : {
        status: awaitingDraw ? ('unfrozen' as const) : ('fixed_draw' as const),
        reason: awaitingDraw
          ? 'This entrant is eligible for a future finals draw, subject to the confirmed pool order. Prior tie rulings stay recorded.'
          : 'The existing draw, used qualifiers, finals places and eliminations stay fixed.',
      };
  const waitingMembers = entrant && !available(next.entrants.find((e) => e.id === entrant.id)!);
  return {
    allowed: !issues.length,
    issues,
    warnings: issues.length
      ? []
      : [
          ...(waitingMembers ? ['An entrant or team-member availability hold still applies.'] : []),
          ...(!effects.some((effect) => effect.effect === 'resumable')
            ? ['No matches become ready to call.']
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
