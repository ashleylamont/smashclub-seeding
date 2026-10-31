import type { TournamentDecision, TournamentState } from './schemas';
import { matchNames } from './matchNames';

export type HistoryCategory =
  'scores' | 'matches' | 'players' | 'draw' | 'settings' | 'results' | 'broadcast';
export type HistoryDescription = {
  category: HistoryCategory;
  title: string;
  summary: string;
  matchId: string | null;
};

function decisionContext(
  decision: TournamentDecision,
  state: TournamentState,
  playerName?: (id: string | null) => string | undefined,
) {
  const command = decision.command;
  const report =
    command.kind === 'review'
      ? (decision.after.reports ?? state.reports).find((item) => item.id === command.reportId)
      : undefined;
  const matchId = 'matchId' in command ? command.matchId : (report?.matchId ?? null);
  const match = (decision.after.matches ?? state.matches).find((item) => item.id === matchId);
  const labels = matchNames({
    matches: decision.after.matches ?? state.matches,
    brackets: decision.after.brackets ?? state.brackets,
  });
  const player = (id: string | null) =>
    state.entrants.find((item) => item.playerId === id)?.name ??
    state.baseline?.entrants.find((item) => item.playerId === id)?.name ??
    playerName?.(id) ??
    'Player';
  const pairing = match
    ? `${labels.get(match.id) ?? match.label}: ${player(match.player1Id)} vs ${player(match.player2Id)}`
    : 'Match';
  const station = (id: string | null) =>
    id
      ? (state.stations.find((item) => item.id === id)?.name ?? 'Recorded station')
      : 'No station assigned';
  return { command, report, matchId, player, pairing, station };
}

export function describeDecision(
  decision: TournamentDecision,
  state: TournamentState,
  playerName?: (id: string | null) => string | undefined,
): HistoryDescription {
  const { command, report, matchId, player, pairing, station } = decisionContext(
    decision,
    state,
    playerName,
  );
  const result = (
    score1: number | null,
    score2: number | null,
    outcome: string,
    winnerId?: string,
  ) =>
    outcome === 'forfeit'
      ? `${pairing} · ${player(winnerId ?? null)} wins by forfeit`
      : `${pairing} · ${score1 ?? '–'}–${score2 ?? '–'} · ${outcome.replaceAll('_', ' ')}`;
  const description = (category: HistoryCategory, title: string, summary: string) => ({
    category,
    title,
    summary,
    matchId,
  });
  const dispatch = describeDispatchCommand(command, state, pairing, station);
  if (command.kind === 'broadcastSides')
    return description(
      'broadcast',
      'Overlay sides changed',
      `${station(command.stationId)} · ${pairing} · ${command.swapped ? 'Swapped left / right' : 'Recorded player order'}`,
    );
  if (dispatch) return { ...dispatch, matchId };
  switch (command.kind) {
    case 'score': {
      const pending = decision.after.reports?.some(
        (item) => item.id === decision.receipt.reportId && item.status === 'pending',
      );
      return description(
        'scores',
        pending
          ? 'Score submitted for review'
          : decision.correctionOf
            ? 'Result corrected'
            : 'Result recorded',
        result(command.score1, command.score2, command.outcome, command.winnerId),
      );
    }
    case 'review':
      return description(
        'scores',
        command.approve ? 'Score approved' : 'Score rejected',
        report ? result(report.score1, report.score2, report.outcome, report.winnerId) : pairing,
      );
    case 'progress':
      return description(
        'scores',
        'Live score updated',
        result(command.score1, command.score2, 'in progress'),
      );
    case 'matchControl':
      return description(
        'matches',
        command.status === 'blocked' ? 'Match held' : 'Match made ready',
        `${pairing} · ${station(command.stationId)}${command.reason ? ` · ${command.reason}` : ''}`,
      );
    case 'availability':
      return description(
        'players',
        'Player availability changed',
        `${player(command.playerId)} · ${command.availability} · ${command.reason}`,
      );
    case 'attendance':
      return description(
        'players',
        command.action === 'restore' ? 'Entrant restored' : 'Attendance changed',
        `${command.entrant?.name ?? player(command.playerId)} · ${command.action.replaceAll('_', ' ')}${command.reason ? ` · ${command.reason}` : ''}`,
      );
    case 'placements':
      return description(
        'draw',
        'Pool order confirmed',
        `${command.order.length} players in their chosen order`,
      );
    case 'poolOrders':
      return description(
        'draw',
        'Pool orders confirmed',
        `${command.pools.length} pools in their chosen orders`,
      );
    case 'configurePools':
      return description(
        'settings',
        'Pool stations and reporting changed',
        `${command.pools.length} pools configured`,
      );
    case 'poolResources':
      return description(
        'settings',
        'Pool stations and reporting changed',
        `${command.active ? 'Active' : 'Paused'} · ${command.stationIds.length} stations · ${command.selfRun ? 'Self-run' : 'TO-run'}`,
      );
    case 'station':
      return description(
        'settings',
        command.name ? 'Station saved' : 'Station removed',
        command.name ??
          state.stations.find((station) => station.id === command.id)?.name ??
          'Station',
      );
    case 'resources':
      return description(
        'settings',
        'Station capacity changed',
        `${command.capacity} simultaneous matches · ${command.stations.length} stations`,
      );
    case 'reporting':
      return description(
        'settings',
        'Publishing and score reporting changed',
        `${command.published ? 'Public board published' : 'Public board hidden'} · ${command.playerReports ? 'Player reporting enabled' : 'Player reporting disabled'} · ${command.mode === 'to_review' ? 'TO review' : 'Approve unless disputed'}`,
      );
    case 'announce':
      return description('broadcast', 'Announcement posted', command.message);
    case 'prize':
      return description(
        'broadcast',
        'Prize saved',
        `${command.title}${command.playerId ? ` · ${player(command.playerId)}` : ''}`,
      );
    case 'drawFinals':
      return description('draw', 'Finals drawn', 'The chosen finals pairings were recorded.');
    case 'resetFinals':
      return description('draw', 'Unplayed finals reset', 'Finals were cleared before play.');
    case 'resetQueue':
      return description('draw', 'Unplayed match queue reset', 'Pool assignments were retained.');
    case 'unlock':
      return description('draw', 'Draw paused', 'The draw and its history were retained.');
    case 'relock':
      return description('draw', 'Draw resumed', 'The existing draw resumed.');
    case 'cancel':
      return description('results', 'Event cancelled', command.reason);
    case 'retire':
      return description(
        'results',
        command.operation === 'reset' ? 'Event reverted to a fresh draft' : 'Event deleted',
        `${command.reason} · ${command.withdrawResults ? 'Published results withdrawn' : 'Published results retained'}`,
      );
    case 'finalize':
      return description(
        'results',
        'Results sealed',
        'Final results were queued for publication to club history.',
      );
    case 'replaceResult':
      return description(
        'results',
        'Result correction sealed',
        `${command.corrections.length} match corrections · ${command.reason}`,
      );
    default:
      throw new Error(`No history description for ${command.kind}`);
  }
}

function describeDispatchCommand(
  command: TournamentDecision['command'],
  state: TournamentState,
  pairing: string,
  station: (id: string | null) => string,
) {
  switch (command.kind) {
    case 'dispatch':
      return {
        category: 'matches' as const,
        title:
          command.callOnly ||
          (state.settings.dispatchMode === 'shared' &&
            !command.stationId &&
            command.callOnly !== false)
            ? 'Match called'
            : 'Match started',
        summary: `${pairing} · ${station(command.stationId)}${command.callLocation ? ` · ${command.callLocation}` : ''}`,
      };
    case 'beginPlay':
      return { category: 'matches' as const, title: 'Called match started', summary: pairing };
    case 'configureDispatch':
      return {
        category: 'settings' as const,
        title: 'Shared match capacity configured',
        summary: `${command.capacity} ordinary matches plus ${command.reservedStationIds.length} named stations`,
      };
    case 'queueMove':
      return { category: 'matches' as const, title: 'TO queue reordered', summary: pairing };
    default:
      return null;
  }
}
