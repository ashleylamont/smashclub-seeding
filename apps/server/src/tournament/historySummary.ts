import type { TournamentDecision, TournamentState } from './schemas';
import { publicEntrantName } from './entrants';
import { matchNames } from './matchNames';

export type HistoryCategory =
  'scores' | 'matches' | 'players' | 'draw' | 'settings' | 'results' | 'broadcast';
export type HistoryDescription = {
  category: HistoryCategory;
  title: string;
  summary: string;
  matchId: string | null;
};
export type HistoryContext = Partial<
  Pick<TournamentState, 'entrants' | 'matches' | 'brackets' | 'reports' | 'stations' | 'settings'>
>;

function decisionContext(
  decision: TournamentDecision,
  context: HistoryContext,
  playerName: (id: string) => string | undefined,
) {
  const command = decision.command;
  const report =
    command.kind === 'review'
      ? context.reports?.find((item) => item.id === command.reportId)
      : undefined;
  const matchId = 'matchId' in command ? command.matchId : (report?.matchId ?? null);
  const matches = context.matches ?? [];
  const match = matchId ? matches.find((item) => item.id === matchId) : undefined;
  const player = (id: string | null) => {
    if (!id) return 'Player';
    const entrant = context.entrants?.find((item) => item.playerId === id);
    return entrant?.memberPlayerIds
      ? publicEntrantName(entrant, playerName)
      : (playerName(id) ?? 'Player');
  };
  const pairing = match
    ? `${matchNames({ matches, brackets: context.brackets ?? [] }).get(match.id) ?? match.label}: ${player(match.player1Id)} vs ${player(match.player2Id)}`
    : 'Match';
  const station = (id: string | null) =>
    id
      ? (context.stations?.find((item) => item.id === id)?.name ?? 'Recorded station')
      : 'No station assigned';
  return { command, report, matchId, player, pairing, station };
}

export function describeDecision(
  decision: TournamentDecision,
  context: HistoryContext,
  playerName: (id: string) => string | undefined,
): HistoryDescription {
  const { command, report, matchId, player, pairing, station } = decisionContext(
    decision,
    context,
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
  const dispatch = describeDispatchCommand(command, context, pairing, station);
  if (command.kind === 'broadcastSides')
    return description(
      'broadcast',
      'Overlay sides changed',
      `${station(command.stationId)} · ${pairing} · ${command.swapped ? 'Swapped left / right' : 'Recorded player order'}`,
    );
  if (dispatch) return { ...dispatch, matchId };
  const attendance = describeAttendance(command, player, context, playerName);
  if (attendance) return { ...attendance, matchId };
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
          context.stations?.find((station) => station.id === command.id)?.name ??
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
    case 'replayFinalsSlotV1':
    case 'replayFinalsRoutesV2':
      return describeFinalsReplay(decision, command.reason, matchId, player);
    case 'drawFinals':
      return description('draw', 'Finals drawn', 'The chosen finals pairings were recorded.');
    case 'resetFinals':
      return describeFinalsReset(command, matchId);
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

function describeFinalsReset(
  command: Extract<TournamentDecision['command'], { kind: 'resetFinals' }>,
  matchId: string | null,
): HistoryDescription {
  if (!command.scope)
    return {
      category: 'draw',
      title: 'Unplayed finals reset',
      summary: 'Finals were cleared before play.',
      matchId,
    };
  const division = command.scope.division === 'upper' ? 'Upper' : 'Lower';
  return {
    category: 'draw',
    title: `Unplayed ${division} finals reset`,
    summary: `${division} finals were cleared before play.`,
    matchId,
  };
}

function describeFinalsReplay(
  decision: TournamentDecision,
  reason: string,
  sourceMatchId: string | null,
  player: (id: string | null) => string,
): HistoryDescription {
  const archived = decision.after.supersededPlayedSets?.at(-1);
  const replacement = decision.after.matches?.find(
    (match) => match.id === archived?.replacementMatchId,
  );
  const base = { category: 'draw' as const, title: 'Finals replay scheduled' };
  if (!archived || !replacement) return { ...base, matchId: sourceMatchId, summary: reason };
  const oldPairing = `${player(archived.match.player1Id)} vs ${player(archived.match.player2Id)}`;
  const newPairing = `${player(replacement.player1Id)} vs ${player(replacement.player2Id)}`;
  const companion = decision.finalsReplayCompanion;
  const consolation = companion
    ? ` ${companion.label} changes from ${player(companion.beforeEntrantId)} to ${player(companion.afterEntrantId)}.`
    : '';
  return {
    ...base,
    matchId: replacement.id,
    summary: `${oldPairing} ${archived.match.score1}–${archived.match.score2} stays recorded with superseded advancement. Replay ${newPairing}.${consolation} ${reason}`,
  };
}

function describeDispatchCommand(
  command: TournamentDecision['command'],
  context: HistoryContext,
  pairing: string,
  station: (id: string | null) => string,
) {
  switch (command.kind) {
    case 'dispatch': {
      const implicitCall = !command.stationId && command.callOnly === undefined;
      return {
        category: 'matches' as const,
        title:
          implicitCall && !context.settings
            ? 'Match dispatch recorded'
            : command.callOnly || (implicitCall && context.settings?.dispatchMode === 'shared')
              ? 'Match called'
              : 'Match started',
        summary: `${pairing} · ${station(command.stationId)}${command.callLocation ? ` · ${command.callLocation}` : ''}`,
      };
    }
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

function describeAttendance(
  command: TournamentDecision['command'],
  player: (id: string | null) => string,
  context: HistoryContext,
  playerName: (id: string) => string | undefined,
) {
  switch (command.kind) {
    case 'renameDoublesPair': {
      const entrant = context.entrants?.find((entry) => entry.id === command.entrantId);
      const pair = entrant ? publicEntrantName({ ...entrant, teamName: null }, playerName) : 'Pair';
      return {
        category: 'players' as const,
        title: 'Doubles pair name changed',
        summary: command.teamName
          ? `${pair} · Name set to ${command.teamName}`
          : `${pair} · Team name cleared`,
      };
    }
    case 'availability':
      return {
        category: 'players' as const,
        title: 'Player availability changed',
        summary: `${player(command.playerId)} · ${command.availability} · ${command.reason}`,
      };
    case 'addLateDoublesPair':
      return {
        category: 'players' as const,
        title: 'Late doubles pair admitted',
        summary: `${command.identity?.memberNames.join(' / ')} · ${command.reason}`,
      };
    case 'substituteDoublesMember':
      return {
        category: 'players' as const,
        title: 'Doubles substitute confirmed',
        summary: `${command.identity?.oldMemberNames.join(' / ')} → ${command.identity?.newMemberNames.join(' / ')} · ${command.reason}`,
      };
    case 'attendance':
      return {
        category: 'players' as const,
        title: command.action === 'restore' ? 'Entrant restored' : 'Attendance changed',
        summary: `${command.entrant?.name ?? player(command.playerId)} · ${command.action.replaceAll('_', ' ')}${command.reason ? ` · ${command.reason}` : ''}`,
      };
    default:
      return null;
  }
}
