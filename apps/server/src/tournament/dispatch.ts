import { hasCurrentPendingScoreReview } from './scoreReview';
import { available, memberIds } from './entrants';
import { requireFact, resolved } from './facts';
import type { Match, TournamentState, CommandEnvelope } from './schemas';

export const sharedDispatch = (state: TournamentState) => state.settings.dispatchMode === 'shared';
export const isReserved = (state: TournamentState, stationId: string | null) =>
  Boolean(stationId && state.settings.reservedStationIds?.includes(stationId));

export function ordinaryUsage(state: TournamentState) {
  return state.matches.filter((m) => m.status === 'playing' && !isReserved(state, m.stationId))
    .length;
}

/** Index a snapshot once; large round robins must not rescan every match and
 * entrant for each suggestion or each comparison in the sort. */
export function dispatchContext(state: TournamentState) {
  const members = new Map(state.entrants.map((e) => [e.playerId, memberIds(e)]));
  const ids = (match: Match) => [
    ...(members.get(match.player1Id ?? '') ?? []),
    ...(members.get(match.player2Id ?? '') ?? []),
  ];
  const reports = new Map<string, TournamentState['reports']>();
  for (const report of state.reports) {
    const bucket = reports.get(report.matchId) ?? [];
    bucket.push(report);
    reports.set(report.matchId, bucket);
  }
  const busy = new Map<string, Match>();
  const occupied = new Set<string>();
  for (const match of state.matches.filter((m) => m.status === 'playing')) {
    for (const id of ids(match)) busy.set(id, match);
    if (match.stationId) occupied.add(match.stationId);
  }
  return {
    ids,
    busy,
    occupied,
    pools: new Map(state.pools.map((p) => [p.id, p])),
    unavailable: new Set(state.entrants.filter((e) => !available(e)).map((e) => e.playerId)),
    complete: new Set(state.matches.filter(resolved).map((m) => m.id)),
    pendingReports: new Set(
      state.matches
        .filter((match) => hasCurrentPendingScoreReview(match, reports.get(match.id) ?? []))
        .map((match) => match.id),
    ),
    ordinaryAvailable: ordinaryUsage(state) < state.settings.capacity,
    reservedStations: state.stations.filter(
      (station) => station.enabled && isReserved(state, station.id),
    ),
  };
}

/** One readiness policy for the private desk, projections and authoritative dispatch. */
export function dispatchAvailability(
  state: TournamentState,
  match: Match,
  context = dispatchContext(state),
) {
  const reasons: { code: string; message: string }[] = [];
  const add = (code: string, message: string) => reasons.push({ code, message });
  if (state.lifecycle !== 'locked') add('event_closed', 'The event is not open for calls.');
  if (match.status === 'complete') add('complete', 'This match has finished.');
  if (match.status === 'playing') add('playing', 'This match is already called or playing.');
  if (match.status === 'blocked')
    add('held', match.blockedReason ?? 'Waiting for earlier results.');
  if (!match.player1Id || !match.player2Id)
    add('opponents_unknown', 'Waiting for both opponents to be confirmed.');
  if ([match.parent1Id, match.parent2Id].some((id) => id && !context.complete.has(id)))
    add('dependency', 'Waiting for a feeder result.');
  if (match.qualificationBlocks?.length)
    add(
      'qualification_pending',
      match.blockedReason ?? 'A qualifying pool result or finishing order awaits review.',
    );
  if (context.pendingReports.has(match.id))
    add('score_review_pending', 'This match has a score awaiting TO review.');
  const pool = context.pools.get(match.poolId ?? '');
  if (pool && !pool.active) add('pool_held', 'This pool is on hold.');
  if ([match.player1Id, match.player2Id].some((id) => id && context.unavailable.has(id)))
    add('player_unavailable', 'An entrant or team member is unavailable.');
  const busy = context
    .ids(match)
    .map((id) => context.busy.get(id))
    .find((m) => m && m.id !== match.id);
  if (busy) add('player_busy', `An entrant or team member is already called in ${busy.label}.`);
  const eligibleStationIds = context.reservedStations
    .filter((station) => !context.occupied.has(station.id))
    .map((station) => station.id);
  const ready = reasons.length === 0;
  if (!context.ordinaryAvailable && !eligibleStationIds.length)
    add(
      'capacity_full',
      'All ordinary capacity and reserved stations are occupied or unavailable.',
    );
  return {
    canStart: ready && (context.ordinaryAvailable || eligibleStationIds.length > 0),
    canDispatchOrdinary: ready && context.ordinaryAvailable,
    eligibleStationIds: ready ? eligibleStationIds : [],
    reasons,
  };
}

/** Waiting is measured from the last completed set of either entrant. An older
 * waiting band outranks dependency benefit, so new ready work cannot starve it.
 * Explicit TO ordering is a deliberate override, not a promised schedule. */
export function dispatchQueue(state: TournamentState) {
  const context = dispatchContext(state);
  const drawOrder = new Map(state.matches.map((m, i) => [m.id, i]));
  const downstreamCount = new Map<string, number>();
  for (const match of state.matches.filter((m) => !resolved(m)))
    for (const parent of [match.parent1Id, match.parent2Id])
      if (parent) downstreamCount.set(parent, (downstreamCount.get(parent) ?? 0) + 1);
  const baseTime = state.baseline?.capturedAt ?? 0;
  const lastPlayed = new Map<string, number>();
  for (const m of state.matches.filter((m) => resolved(m) && m.completedAt !== null))
    for (const id of context.ids(m))
      lastPlayed.set(id, Math.max(lastPlayed.get(id) ?? baseTime, m.completedAt!));
  const order = new Map((state.settings.queueOrder ?? []).map((id, i) => [id, i]));
  const pending = state.matches
    .filter((m) => !resolved(m))
    .map((m) => {
      const waitingSince = Math.max(
        m.readySince ?? baseTime,
        ...context.ids(m).map((id) => lastPlayed.get(id) ?? baseTime),
      );
      const downstream = downstreamCount.get(m.id) ?? 0;
      const availability = dispatchAvailability(state, m, context);
      return {
        matchId: m.id,
        state:
          m.status === 'playing'
            ? m.started
              ? ('playing' as const)
              : ('called' as const)
            : availability.canStart
              ? ('ready' as const)
              : ('blocked' as const),
        waitingSince,
        downstream,
        reason: order.has(m.id)
          ? 'TO order'
          : downstream
            ? 'Waiting time, then feeder matches'
            : 'Waiting time, then draw order',
        ...availability,
      };
    });
  pending.sort(
    (a, b) =>
      (order.get(a.matchId) ?? Infinity) - (order.get(b.matchId) ?? Infinity) ||
      Math.floor(a.waitingSince / 300_000) - Math.floor(b.waitingSince / 300_000) ||
      b.downstream - a.downstream ||
      a.waitingSince - b.waitingSince ||
      (drawOrder.get(a.matchId) ?? 0) - (drawOrder.get(b.matchId) ?? 0),
  );
  return pending;
}

/** Atomic conversion retains actual calls/results/identities. Legacy ordinary
 * station labels remain call locations; only future dispatch loses the binding. */
export function configureDispatch(
  state: TournamentState,
  command: Extract<CommandEnvelope['command'], { kind: 'configureDispatch' }>,
  basis: Record<string, number>,
) {
  requireFact(
    state.settings.resourceRevision === command.expectedResourceRevision,
    'Resources changed. Review the current calls.',
  );
  requireFact(
    new Set(command.reservedStationIds).size === command.reservedStationIds.length &&
      command.reservedStationIds.every((id) => state.stations.some((s) => s.id === id)),
    'Choose distinct named stations in this event.',
  );
  basis.resources = state.settings.resourceRevision;
  for (const match of state.matches) {
    if (
      match.status === 'playing' &&
      match.stationId &&
      !command.reservedStationIds.includes(match.stationId)
    )
      match.callLocation ??= state.stations.find((s) => s.id === match.stationId)?.name ?? null;
    if (match.status !== 'playing' && !resolved(match)) match.stationId = null;
  }
  for (const pool of state.pools) {
    if (pool.stationIds.length) {
      pool.stationIds = [];
      pool.scheduleRevision++;
    }
  }
  Object.assign(state.settings, {
    dispatchMode: 'shared',
    capacity: command.capacity,
    reservedStationIds: command.reservedStationIds,
    resourceRevision: state.settings.resourceRevision + 1,
  });
}

export function dispatchDesk(state: TournamentState, names?: ReadonlyMap<string, string>) {
  const active = ordinaryUsage(state);
  return {
    mode: sharedDispatch(state) ? ('shared' as const) : ('station' as const),
    capacity: state.settings.capacity,
    active,
    overCapacity: Math.max(0, active - state.settings.capacity),
    resourceRevision: state.settings.resourceRevision,
    queueRevision: state.settings.queueRevision ?? 0,
    stations: state.stations.map((s) => ({
      ...s,
      reserved: isReserved(state, s.id),
      currentMatchId:
        state.matches.find((m) => m.status === 'playing' && m.stationId === s.id)?.id ?? null,
    })),
    queue: dispatchQueue(state),
    entrants: state.entrants.map((e) => ({
      id: e.playerId,
      name: names?.get(e.playerId) ?? e.name,
      revision: e.revision,
      availability: e.availability,
      members: memberIds(e).map((id) => ({
        id,
        availability: e.memberAvailability?.[id] ?? ('available' as const),
      })),
    })),
    pools: state.pools.map((p) => ({
      id: p.id,
      division: p.division,
      index: p.index,
      active: p.active,
      revision: p.scheduleRevision,
      selfRun: p.selfRun,
      autoAcceptScores: p.autoAcceptScores,
    })),
  };
}

/** Private operator ordering never travels in public snapshots. */
export function publicSettings(state: TournamentState) {
  const value = state.settings;
  return {
    published: value.published,
    playerReports: value.playerReports,
    scoreReportingMode: value.scoreReportingMode,
    capacity: value.capacity,
    resourceRevision: value.resourceRevision,
    reportingRevision: value.reportingRevision,
    ...(value.dispatchMode ? { dispatchMode: value.dispatchMode } : {}),
  };
}

export function moveQueue(
  state: TournamentState,
  command: Extract<CommandEnvelope['command'], { kind: 'queueMove' }>,
  basis: Record<string, number>,
) {
  requireFact(sharedDispatch(state), 'Enable the shared match queue first.');
  requireFact(
    (state.settings.queueRevision ?? 0) === command.expectedQueueRevision,
    'Queue order changed. Refresh before reordering.',
  );
  const match = state.matches.find((m) => m.id === command.matchId);
  requireFact(
    match && match.status === 'ready',
    'Only an uncalled ready pairing can be reordered.',
  );
  const ids = dispatchQueue(state)
    .filter((row) => state.matches.find((m) => m.id === row.matchId)?.status === 'ready')
    .map((r) => r.matchId);
  requireFact(
    command.beforeMatchId === null ||
      (command.beforeMatchId !== command.matchId && ids.includes(command.beforeMatchId)),
    'The target pairing changed.',
  );
  const order = ids.filter((id) => id !== command.matchId);
  order.splice(
    command.beforeMatchId === null ? order.length : order.indexOf(command.beforeMatchId),
    0,
    command.matchId,
  );
  basis.queue = state.settings.queueRevision ?? 0;
  state.settings.queueOrder = order;
  state.settings.queueRevision = (state.settings.queueRevision ?? 0) + 1;
}

export function beginPlay(
  state: TournamentState,
  command: Extract<CommandEnvelope['command'], { kind: 'beginPlay' }>,
  basis: Record<string, number>,
) {
  const match = state.matches.find((m) => m.id === command.matchId);
  requireFact(
    match &&
      match.status === 'playing' &&
      match.revision === command.expectedRevision &&
      state.settings.resourceRevision === command.expectedResourceRevision,
    'The called match or resources changed.',
  );
  basis[match.id] = match.revision;
  basis.resources = state.settings.resourceRevision;
  match.started = true;
  state.settings.resourceRevision++;
}

export function changeStation(
  state: TournamentState,
  command: Extract<CommandEnvelope['command'], { kind: 'station' }>,
  basis: Record<string, number>,
) {
  requireFact(
    state.settings.resourceRevision === command.expectedResourceRevision,
    'Stations changed.',
  );
  basis.resources = state.settings.resourceRevision;
  const station = state.stations.find((s) => s.id === command.id);
  if (command.name === null) {
    requireFact(
      station && !state.matches.some((m) => m.stationId === command.id && m.status === 'playing'),
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
  } else state.stations.push({ id: command.id, name: command.name, enabled: true, revision: 0 });
  if (sharedDispatch(state)) {
    if (command.name && !station)
      state.settings.reservedStationIds = [
        ...(state.settings.reservedStationIds ?? []),
        command.id,
      ];
    if (!command.name)
      state.settings.reservedStationIds = state.settings.reservedStationIds?.filter(
        (id) => id !== command.id,
      );
  } else state.settings.capacity = state.stations.length;
  state.settings.resourceRevision++;
}

export function updateResources(
  next: TournamentState,
  command: Extract<CommandEnvelope['command'], { kind: 'resources' }>,
  basis: Record<string, number>,
) {
  requireFact(
    next.settings.resourceRevision === command.expectedResourceRevision,
    'Resources changed.',
  );
  requireFact(
    new Set(command.stations.map((s) => s.id)).size === command.stations.length,
    'Duplicate station.',
  );
  requireFact(
    sharedDispatch(next) ||
      next.matches.filter((m) => m.status === 'playing').length <= command.capacity,
    'Capacity cannot strand playing matches.',
  );
  requireFact(
    next.matches
      .filter((m) => m.status === 'playing' && m.stationId)
      .every((m) => command.stations.some((s) => s.id === m.stationId && s.enabled)),
    'A reserved station is still in use.',
  );
  requireFact(
    !sharedDispatch(next) ||
      (next.settings.reservedStationIds ?? []).every((id) =>
        command.stations.some((s) => s.id === id),
      ),
    'A named station is still reserved. Change its reservation before removing it.',
  );
  basis.resources = next.settings.resourceRevision;
  next.settings.capacity = command.capacity;
  next.settings.resourceRevision++;
  next.stations = command.stations.map((s) => ({
    ...s,
    revision: (next.stations.find((old) => old.id === s.id)?.revision ?? -1) + 1,
  }));
  requireFact(
    next.pools.every((p) => p.stationIds.every((id) => next.stations.some((s) => s.id === id))),
    'A pool still reserves a station being removed.',
  );
}

export function stampReadySince(previous: TournamentState, next: TournamentState, at: number) {
  if (!sharedDispatch(next)) return;
  const statuses = new Map(previous.matches.map((m) => [m.id, m.status]));
  for (const match of next.matches)
    if (match.status === 'ready' && statuses.get(match.id) !== 'ready') match.readySince = at;
}

export type SharedDispatchSummary = { capacity: number; active: number; overCapacity: number };
