import { sealResults } from './results';
import { memberIds, changeAvailability } from './entrants';
import { dispatchMatch } from './scheduling';
import { additionalDecision, finalsToken, resetFinals } from './operations';
import { drawFinals } from './brackets';
import { hash, receiptKey, requireFact, resolved, sameScore } from './facts';
import { applyScore, recordScore } from './scores';
import {
  initialState,
  type CommandEnvelope,
  type TournamentBaseline,
  type TournamentDecision,
  type TournamentState,
} from './schemas';
export { hash, receiptKey, stableId, TournamentConflict } from './facts';

export function captureBaseline(baseline: TournamentBaseline): TournamentState {
  if (baseline.version === 2)
    requireFact(
      baseline.competitionFormat && baseline.structure,
      'V2 baselines need a competition format and structure.',
    );
  if (baseline.structure === 'round_robin')
    requireFact(
      baseline.pools.length === 1 && baseline.pools[0]!.division === 'upper',
      'An open round robin needs exactly one open pool.',
    );
  if (baseline.structure === 'pools_finals')
    requireFact(
      baseline.pools.every((p) => p.division === 'upper'),
      'Open pools use one competitive division.',
    );
  const entrantIds = new Set(baseline.entrants.map((e) => e.playerId));
  requireFact(entrantIds.size === baseline.entrants.length, 'Duplicate baseline entrants.');
  const members = baseline.entrants.flatMap(memberIds);
  requireFact(new Set(members).size === members.length, 'A player cannot enter more than once.');
  requireFact(
    baseline.entrants.every(
      (e) => memberIds(e).length === (baseline.competitionFormat === 'doubles' ? 2 : 1),
    ),
    'Entrant membership does not match the competition format.',
  );
  requireFact(
    new Set(baseline.matches.map((m) => m.id)).size === baseline.matches.length,
    'Duplicate match IDs.',
  );
  requireFact(
    baseline.matches.every(
      (m) =>
        ['ready', 'blocked'].includes(m.status) &&
        !m.started &&
        !m.outcome &&
        m.player1Id &&
        m.player2Id &&
        m.player1Id !== m.player2Id &&
        entrantIds.has(m.player1Id) &&
        entrantIds.has(m.player2Id),
    ),
    'Only an unplayed native draw can be adopted.',
  );
  const assigned = baseline.pools.flatMap((p) => p.entrantIds);
  requireFact(
    assigned.length === entrantIds.size &&
      new Set(assigned).size === entrantIds.size &&
      assigned.every((id) => entrantIds.has(id)),
    'Each entrant needs exactly one pool.',
  );
  requireFact(
    new Set(baseline.pools.map((p) => p.id)).size === baseline.pools.length,
    'Duplicate pool IDs.',
  );
  for (const pool of baseline.pools) {
    const matches = baseline.matches.filter((m) => m.poolId === pool.id);
    const pairs = matches.map((m) => [m.player1Id, m.player2Id].sort().join(':'));
    requireFact(
      matches.length === (pool.entrantIds.length * (pool.entrantIds.length - 1)) / 2 &&
        new Set(pairs).size === matches.length,
      'Baseline must contain the actual complete round-robin draw.',
    );
    requireFact(
      matches.every(
        (m) =>
          m.division === pool.division &&
          m.stage === 'group' &&
          !m.parent1Id &&
          !m.parent2Id &&
          !m.bracketId &&
          pool.entrantIds.includes(m.player1Id!) &&
          pool.entrantIds.includes(m.player2Id!),
      ),
      'Baseline match is outside its pool draw.',
    );
  }
  requireFact(
    baseline.matches.every((m) => baseline.pools.some((p) => p.id === m.poolId)),
    'Unknown baseline pool.',
  );
  return {
    ...initialState(),
    baseline,
    sequence: 1,
    lifecycle: 'locked',
    entrants: baseline.entrants,
    pools: baseline.pools,
    matches: baseline.matches,
    stations: baseline.stations,
    settings: baseline.settings,
    announcements: baseline.announcements,
    prizes: baseline.prizes,
  };
}

export function decide(
  previous: TournamentState,
  envelope: CommandEnvelope,
): TournamentDecision | undefined {
  const key = receiptKey(envelope.actorId, envelope.requestId);
  const inputHash = envelope.inputHash ?? hash(envelope.command);
  if (previous.receipts[key]) {
    requireFact(
      previous.receipts[key].hash === inputHash,
      'Request identifier already used for a different command.',
    );
    return undefined;
  }
  requireFact(previous.baseline, 'Baseline transfer has not completed.');
  requireFact(
    (previous.lifecycle !== 'finalized' || envelope.command.kind === 'replaceResult') &&
      previous.lifecycle !== 'cancelled',
    'Results are sealed. Use an explicit replacement revision workflow.',
  );
  const command = envelope.command;
  requireFact(
    envelope.operator || command.kind === 'score' || command.kind === 'dispatch',
    'Only an organiser can perform this action.',
  );
  requireFact(
    previous.lifecycle === 'locked' ||
      [
        'relock',
        'resources',
        'reporting',
        'poolResources',
        'station',
        'configurePools',
        'cancel',
        'replaceResult',
        'attendance',
        'resetQueue',
      ].includes(command.kind),
    'Relock before making live decisions.',
  );
  const next = structuredClone(previous);
  const basis: Record<string, number> = {};
  let reportId: string | null = null;
  switch (command.kind) {
    case 'score':
      reportId = recordScore(next, envelope, command, basis);
      break;
    case 'review': {
      const report = next.reports.find((r) => r.id === command.reportId);
      requireFact(report && report.status === 'pending', 'This report is no longer pending.');
      const match = next.matches.find((m) => m.id === report.matchId)!;
      requireFact(
        match.revision === command.expectedRevision &&
          (!command.approve || report.expectedRevision === match.revision),
        'This report refers to an earlier result or pairing.',
      );
      basis[match.id] = match.revision;
      if (command.approve && !sameScore(match, report))
        applyScore(next, match, report, envelope.at, false, envelope.id);
      report.status = command.approve ? 'approved' : 'rejected';
      report.isDispute = false;
      break;
    }
    case 'dispatch':
      dispatchMatch(next, envelope, command, basis);
      break;
    case 'availability':
      changeAvailability(next, envelope, command, basis);
      break;
    case 'resources': {
      requireFact(
        next.settings.resourceRevision === command.expectedResourceRevision,
        'Resources changed.',
      );
      requireFact(
        new Set(command.stations.map((s) => s.id)).size === command.stations.length,
        'Duplicate station.',
      );
      requireFact(
        next.matches.filter((m) => m.status === 'playing').length <= command.capacity,
        'Capacity cannot strand playing matches.',
      );
      requireFact(
        next.matches
          .filter((m) => m.status === 'playing' && m.stationId)
          .every((m) => command.stations.some((s) => s.id === m.stationId && s.enabled)),
        'A reserved station is still in use.',
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
      break;
    }
    case 'reporting':
      requireFact(
        next.settings.reportingRevision === command.expectedRevision,
        'Reporting settings changed.',
      );
      basis.reporting = next.settings.reportingRevision;
      Object.assign(next.settings, {
        published: command.published,
        playerReports: command.playerReports,
        scoreReportingMode: command.mode,
        reportingRevision: next.settings.reportingRevision + 1,
      });
      break;
    case 'poolResources': {
      const pool = next.pools.find((p) => p.id === command.poolId);
      requireFact(
        pool && next.settings.resourceRevision === command.expectedResourceRevision,
        'Pool or resources changed.',
      );
      requireFact(
        new Set(command.stationIds).size === command.stationIds.length &&
          command.stationIds.every((id) => next.stations.some((s) => s.id === id && s.enabled)),
        'Choose distinct enabled stations in this event.',
      );
      requireFact(
        !next.pools.some(
          (p) =>
            p.id !== pool.id &&
            p.active &&
            p.stationIds.some((id) => command.stationIds.includes(id)) &&
            next.matches.some((m) => m.poolId === p.id && !resolved(m)),
        ),
        'A station is reserved by another unfinished pool.',
      );
      basis.resources = next.settings.resourceRevision;
      Object.assign(pool, {
        active: command.active,
        stationIds: command.stationIds,
        selfRun: command.selfRun,
        autoAcceptScores: command.autoAcceptScores,
      });
      pool.scheduleRevision++;
      next.settings.resourceRevision++;
      break;
    }
    case 'placements': {
      const pool = next.pools.find((p) => p.id === command.poolId);
      requireFact(
        pool && pool.revision === command.expectedRevision && !next.brackets.length,
        'Pool placements changed or finals already exist.',
      );
      requireFact(
        command.order.length === pool.entrantIds.length &&
          new Set(command.order).size === pool.entrantIds.length &&
          command.order.every((id) => pool.entrantIds.includes(id)),
        'Placements must contain each pool entrant exactly once.',
      );
      const matches = next.matches.filter((m) => m.poolId === pool.id);
      requireFact(
        matches.every((m) => resolved(m) && command.matchRevisions[m.id] === m.revision),
        'Resolve and review current pool results.',
      );
      basis[pool.id] = pool.revision;
      for (const m of matches) basis[m.id] = m.revision;
      pool.order = command.order;
      pool.revision++;
      break;
    }
    case 'drawFinals':
      if (command.revisionToken)
        requireFact(
          finalsToken(next) === command.revisionToken,
          'Finals changed since the preview.',
        );
      if (command.replaceExisting) resetFinals(next);
      for (const pool of next.pools) basis[pool.id] = pool.revision;
      drawFinals(next, envelope);
      break;
    case 'unlock':
      requireFact(
        !next.brackets.length &&
          !next.reports.length &&
          next.matches.every((m) => !m.started && !resolved(m)),
        'Play has started; reopening needs an explicit repair.',
      );
      next.lifecycle = 'unlocked';
      break;
    case 'relock':
      requireFact(next.lifecycle === 'unlocked', 'The event is already locked.');
      next.lifecycle = 'locked';
      break;
    case 'finalize':
      sealResults(next, envelope);
      break;
    default:
      requireFact(additionalDecision(next, envelope, basis), 'Unsupported command.');
  }
  const after: TournamentDecision['after'] = {};
  for (const field of [
    'lifecycle',
    'entrants',
    'pools',
    'matches',
    'stations',
    'brackets',
    'settings',
    'reports',
    'result',
    'publication',
    'announcements',
    'prizes',
  ] as const) {
    if (hash(previous[field]) !== hash(next[field])) Object.assign(after, { [field]: next[field] });
  }
  return {
    version: 1,
    commandId: envelope.id,
    actorId: envelope.actorId,
    requestId: envelope.requestId,
    kind: command.kind,
    at: envelope.at,
    basis,
    after,
    receiptKey: key,
    command,
    source: envelope.operator ? 'operator' : envelope.guest ? 'guest' : 'attendee',
    correctionOf:
      command.kind === 'score'
        ? (previous.matches.find((m) => m.id === command.matchId)?.resultCommandId ?? null)
        : null,
    causation: [
      ...new Set(
        previous.matches
          .filter((m) => basis[m.id] !== undefined || command.kind === 'drawFinals')
          .flatMap((m) => (m.resultCommandId ? [m.resultCommandId] : [])),
      ),
    ],
    receipt: { hash: inputHash, sequence: previous.sequence + 1, reportId, commandId: envelope.id },
  };
}

export function reduceDecision(
  state: TournamentState,
  decision: TournamentDecision,
): TournamentState {
  return {
    ...state,
    ...decision.after,
    sequence: decision.receipt.sequence,
    receipts: { ...state.receipts, [decision.receiptKey]: decision.receipt },
  };
}
