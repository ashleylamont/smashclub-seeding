export interface AttentionMatch {
  id: string; label: string; status: string; revision: number;
  player1Id: string | null; player2Id: string | null;
  player1Name: string; player2Name: string;
  blockedReason: string | null;
  availability: { canStart: boolean; reasons: { code: string; message: string }[] };
}
interface AttentionData {
  plan: { status: string };
  matches: AttentionMatch[];
  reports: { id: string; matchId: string; status: string; expectedRevision: number; score1: number; score2: number }[];
  stations: { id: string; name: string; currentMatchId: string | null }[];
  stationQueues: { stationId: string; nextMatchId: string | null; currentMatchId: string | null }[];
}
const normalWaits = new Set(['Waiting for previous round winners', 'Waiting for bracket participants', 'Both players withdrawn: no contest; no winner or score recorded']);

/** A work list of decisions and dispatch opportunities, not every unavailable match. */
export function opsAttention(data: AttentionData) {
  const closed = ['complete', 'cancelled'].includes(data.plan.status);
  const byId = new Map(data.matches.map(match => [match.id, match]));
  const reports = closed ? [] : data.reports.filter(report => report.status === 'pending').map(report => {
    const match = byId.get(report.matchId);
    return { ...report, match, stale: !match || match.revision !== report.expectedRevision };
  });
  const decisions = closed ? [] : data.matches.filter(match => {
    if (match.status !== 'blocked' || normalWaits.has(match.blockedReason ?? '')) return false;
    // Unknown qualifiers alone are normal bracket progress, not a TO decision.
    if ((!match.player1Id || !match.player2Id) && !match.blockedReason) return false;
    return true;
  });
  const dispatch = closed ? [] : data.stationQueues.flatMap(queue => {
    const station = data.stations.find(station => station.id === queue.stationId);
    const match = queue.nextMatchId ? byId.get(queue.nextMatchId) : undefined;
    if (!station || station.currentMatchId || queue.currentMatchId || !match || !match.availability.canStart) return [];
    return [{ station, match }];
  });
  return { reports, decisions, dispatch, needsStations: !closed && !data.stations.length && data.matches.some(match => match.status === 'ready' || match.status === 'playing') };
}

export function jumpToOpsControl(id: string) {
  const target = document.getElementById(id);
  target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target?.focus({ preventScroll: true });
}
