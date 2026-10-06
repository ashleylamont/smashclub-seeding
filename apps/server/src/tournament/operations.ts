import { hash, requireFact, resolved } from './facts';
import { applyAttendance } from './attendance';
import { replaceResult } from './replacement';
import type { CommandEnvelope, TournamentState } from './schemas';

export const finalsToken = (state: TournamentState) =>
  hash({
    pools: state.pools,
    matches: state.matches,
    reports: state.reports,
    brackets: state.brackets,
    lifecycle: state.lifecycle,
  });
export function resetFinals(state: TournamentState) {
  requireFact(
    !state.matches.some(
      (m) =>
        m.bracketId &&
        (m.started || (resolved(m) && m.outcome !== 'bye' && m.outcome !== 'no_contest')),
    ),
    'Finals have actual play and cannot be reset.',
  );
  requireFact(
    !state.reports.some((r) => state.matches.some((m) => m.id === r.matchId && m.bracketId)),
    'Finals have report history.',
  );
  state.matches = state.matches.filter((m) => !m.bracketId);
  state.brackets = [];
  state.settings.resourceRevision++;
}
export function additionalDecision(
  state: TournamentState,
  envelope: CommandEnvelope,
  basis: Record<string, number>,
) {
  const command = envelope.command;
  switch (command.kind) {
    case 'poolOrders':
      requireFact(!state.brackets.length, 'Remove finals before changing qualifying orders.');
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
      m.stationId = command.stationId;
      m.blockedReason = command.reason;
      state.settings.resourceRevision++;
      break;
    }
    case 'configurePools': {
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
    case 'station': {
      requireFact(
        state.settings.resourceRevision === command.expectedResourceRevision,
        'Stations changed.',
      );
      basis.resources = state.settings.resourceRevision;
      const station = state.stations.find((s) => s.id === command.id);
      if (command.name === null) {
        requireFact(
          station &&
            !state.matches.some((m) => m.stationId === command.id && m.status === 'playing'),
          'Station is still in use.',
        );
        state.stations = state.stations.filter((s) => s.id !== command.id);
        for (const pool of state.pools)
          if (pool.stationIds.includes(command.id)) {
            pool.stationIds = pool.stationIds.filter((id) => id !== command.id);
            pool.scheduleRevision++;
          }
        for (const m of state.matches) if (m.stationId === command.id) m.stationId = null;
      } else if (station) {
        station.name = command.name;
        station.revision++;
      } else
        state.stations.push({ id: command.id, name: command.name, enabled: true, revision: 0 });
      state.settings.capacity = state.stations.length;
      state.settings.resourceRevision++;
      break;
    }
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
