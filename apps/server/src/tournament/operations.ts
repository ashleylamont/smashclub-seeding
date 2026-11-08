import { strengthFinalsToken } from './strengthFinals';
import { rollingFinals } from './qualifiers';
import { requirePoolOrderChangeAllowed } from './poolOrders';
import { beginPlay, changeStation, configureDispatch, moveQueue, sharedDispatch } from './dispatch';
import { isKnockout } from '@smashclub/shared';
import { hash, requireFact, resolved, TournamentConflict, unconfirmedCall } from './facts';
import { applyAttendance } from './attendance';
import { replaceResult } from './replacement';
import type { CommandEnvelope, TournamentState } from './schemas';

export const finalsToken = (
  state: TournamentState,
  seedPolicy?: Extract<CommandEnvelope['command'], { kind: 'drawFinals' }>['seedPolicy'],
) =>
  seedPolicy
    ? strengthFinalsToken(state)
    : hash({
        pools: state.pools,
        matches: state.matches,
        reports: state.reports,
        brackets: state.brackets,
        lifecycle: state.lifecycle,
      });

export function finalsResetBlockers(state: TournamentState) {
  const issues: string[] = [];
  const finals = state.matches.filter((match) => match.bracketId);
  if (isKnockout(state.baseline?.structure))
    issues.push('A locked knockout draw can only be changed by creating a new draft.');
  if (
    finals.some(
      (match) =>
        match.started ||
        (resolved(match) && match.outcome !== 'bye' && match.outcome !== 'no_contest'),
    )
  )
    issues.push('Finals have actual play and cannot be reset.');
  const untakenCallIds = finals.filter(unconfirmedCall).map(({ id }) => id);
  if (untakenCallIds.length)
    issues.push('Return untaken finals calls before resetting their draw.');
  const finalsIds = new Set(finals.map(({ id }) => id));
  if (state.reports.some((report) => finalsIds.has(report.matchId)))
    issues.push('Finals have report history.');
  return { issues, untakenCallIds };
}

export function resetFinals(state: TournamentState) {
  const [blocker] = finalsResetBlockers(state).issues;
  if (blocker) throw new TournamentConflict(blocker);
  state.matches = state.matches.filter((m) => !m.bracketId);
  state.brackets = [];
  if (rollingFinals(state)) for (const pool of state.pools) delete pool.qualifierRoster;
  state.settings.resourceRevision++;
}
export function additionalDecision(
  state: TournamentState,
  envelope: CommandEnvelope,
  basis: Record<string, number>,
) {
  const command = envelope.command;
  switch (command.kind) {
    case 'configureDispatch':
      configureDispatch(state, command, basis);
      break;
    case 'queueMove':
      moveQueue(state, command, basis);
      break;
    case 'beginPlay':
      beginPlay(state, command, basis);
      break;
    case 'poolOrders':
      requireFact(
        !state.brackets.length || rollingFinals(state),
        'Remove finals before changing qualifying orders.',
      );
      requireFact(
        new Set(command.pools.map((p) => p.poolId)).size === command.pools.length,
        'Duplicate pool order.',
      );
      for (const order of command.pools) {
        const p = state.pools.find((p) => p.id === order.poolId);
        requireFact(p && p.revision === order.expectedRevision, 'Pool order changed.');
        requireFact(
          order.order.length === p.entrantIds.length &&
            new Set(order.order).size === p.entrantIds.length &&
            order.order.every((id) => p.entrantIds.includes(id)),
          'Include every pool entrant once.',
        );
        const matches = state.matches.filter((m) => m.poolId === p.id);
        requireFact(
          matches.every((m) => resolved(m) && order.matchRevisions[m.id] === m.revision),
          'Review current pool results.',
        );
        basis[p.id] = p.revision;
        for (const m of matches) basis[m.id] = m.revision;
        requirePoolOrderChangeAllowed(state, p, order.order);
        p.order = order.order;
        p.revision++;
      }
      break;
    case 'progress': {
      const m = state.matches.find((m) => m.id === command.matchId);
      requireFact(
        m &&
          m.status === 'playing' &&
          m.revision === command.expectedRevision &&
          m.progressRevision === command.expectedProgressRevision,
        'The playing match changed.',
      );
      basis[m.id] = m.revision;
      basis.progress = m.progressRevision;
      m.started = true;
      m.liveScore1 = command.score1;
      m.liveScore2 = command.score2;
      m.progressRevision++;
      break;
    }
    case 'matchControl': {
      const m = state.matches.find((m) => m.id === command.matchId);
      requireFact(
        m &&
          !resolved(m) &&
          m.revision === command.expectedRevision &&
          state.settings.resourceRevision === command.expectedResourceRevision,
        'Match or resources changed.',
      );
      requireFact(
        !command.stationId || state.stations.some((s) => s.id === command.stationId && s.enabled),
        'Unknown station.',
      );
      basis[m.id] = m.revision;
      basis.resources = state.settings.resourceRevision;
      m.status = command.status;
      if (sharedDispatch(state) || rollingFinals(state)) m.held = command.status === 'blocked';
      m.stationId = command.stationId;
      m.blockedReason = command.reason;
      if (sharedDispatch(state) && command.status === 'ready') {
        m.stationId = null;
        m.calledAt = null;
        m.callLocation = null;
      }
      state.settings.resourceRevision++;
      break;
    }
    case 'configurePools': {
      requireFact(
        !sharedDispatch(state) || command.pools.every((p) => !p.stationIds.length),
        'Shared matches do not reserve stations by pool.',
      );
      for (const setting of command.pools) {
        const pool = state.pools.find((p) => p.id === setting.poolId);
        requireFact(
          pool && pool.scheduleRevision === setting.expectedRevision,
          'Pool scheduling changed.',
        );
        requireFact(
          new Set(setting.stationIds).size === setting.stationIds.length &&
            setting.stationIds.every((id) => state.stations.some((s) => s.id === id && s.enabled)),
          'Choose distinct stations in this event.',
        );
        basis[`schedule:${pool.id}`] = pool.scheduleRevision;
        Object.assign(pool, setting, { scheduleRevision: pool.scheduleRevision + 1 });
      }
      const reserved = new Set<string>();
      for (const pool of state.pools.filter(
        (p) => p.active && state.matches.some((m) => m.poolId === p.id && !resolved(m)),
      ))
        for (const id of pool.stationIds) {
          requireFact(!reserved.has(id), 'Active pools cannot share reserved stations.');
          reserved.add(id);
        }
      state.settings.resourceRevision++;
      break;
    }
    case 'station':
      changeStation(state, command, basis);
      break;
    case 'announce':
      state.announcements.push({
        id: envelope.id,
        message: command.message,
        createdAt: envelope.at,
        expiresAt: command.durationSeconds ? envelope.at + command.durationSeconds * 1000 : null,
      });
      break;
    case 'prize': {
      requireFact(
        !command.playerId || state.entrants.some((e) => e.playerId === command.playerId),
        'Prize recipient must be an entrant.',
      );
      const old = state.prizes.find((p) => p.id === command.id);
      if (old) Object.assign(old, command);
      else state.prizes.push(command);
      break;
    }
    case 'resetFinals':
      requireFact(
        finalsToken(state) === command.revisionToken,
        'Finals changed since the preview.',
      );
      resetFinals(state);
      break;
    case 'resetQueue':
      requireFact(
        !state.matches.some(unconfirmedCall),
        'Return untaken calls before resetting the queue.',
      );
      requireFact(
        !state.reports.length &&
          !state.brackets.length &&
          state.matches.every((m) => !m.started && !resolved(m)),
        'Only an unplayed queue can be reset.',
      );
      for (const pool of state.pools) {
        pool.order = null;
        pool.revision++;
        pool.active = true;
        pool.stationIds = [];
        pool.selfRun = false;
        pool.autoAcceptScores = false;
        pool.scheduleRevision++;
      }
      for (const m of state.matches) {
        m.status = 'ready';
        m.stationId = null;
        m.blockedReason = null;
      }
      state.settings.resourceRevision++;
      break;
    case 'attendance':
      applyAttendance(state, envelope, command);
      break;
    case 'cancel':
      state.lifecycle = 'cancelled';
      break;
    case 'replaceResult':
      replaceResult(state, envelope, command, basis);
      break;
    default:
      return false;
  }
  return true;
}

export function poolDrawPauseBlocker(state: TournamentState) {
  if (
    state.matches.some(
      (match) =>
        match.started ||
        (resolved(match) && match.outcome !== 'bye' && match.outcome !== 'no_contest'),
    )
  )
    return {
      kind: 'actual_play' as const,
      message: 'Play has started. This draw cannot be paused.',
    };
  if (state.reports.length)
    return {
      kind: 'reports' as const,
      message: 'This draw has score reports and cannot be paused.',
    };
  if (state.brackets.length && !isKnockout(state.baseline!.structure))
    return {
      kind: 'finals' as const,
      message: 'Remove any unplayed finals before pausing the pool draw.',
    };
  const matchIds = state.matches.filter(unconfirmedCall).map(({ id }) => id);
  return matchIds.length
    ? {
        kind: 'untaken_calls' as const,
        matchIds,
        message: 'Matches have been called. Return all untaken calls before pausing the draw.',
      }
    : null;
}
