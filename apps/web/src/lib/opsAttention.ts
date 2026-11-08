export interface AttentionMatch {
  id: string;
  label: string;
  status: string;
  revision: number;
  player1Id: string | null;
  player2Id: string | null;
  player1Name: string;
  player2Name: string;
  blockedReason: string | null;
  qualificationWait?: true;
  qualificationBlocks?: { poolId: string; status: 'pending' | 'resolved' | 'review_pending' }[];
  availability: { canStart: boolean; reasons: { code: string; message: string }[] };
}
interface PoolScope {
  division: string;
  poolIndex: number;
}
interface AttentionData {
  plan: { status: string; drawPaused?: boolean };
  poolOrders?: (PoolScope & { poolId: string; plannerConfirmation?: { available: boolean } })[];
  sharedDispatch?: { capacity: number } | null;
  matches: AttentionMatch[];
  reports: {
    id: string;
    matchId: string;
    status: string;
    expectedRevision: number;
    isDispute?: boolean;
    score1: number | null;
    score2: number | null;
  }[];
  stations: { id: string; name: string; currentMatchId: string | null }[];
  stationQueues: { stationId: string; nextMatchId: string | null; currentMatchId: string | null }[];
}
const normalWaits = new Set([
  'Waiting for previous round winners',
  'Waiting for bracket participants',
  'Both players withdrawn: no contest; no winner or score recorded',
]);

const poolKey = ({ division, poolIndex }: PoolScope) => `${division}:${poolIndex}`;

function waitsOnlyForPoolRulings(match: AttentionMatch, rulingIds: ReadonlySet<string>) {
  const sources = match.qualificationBlocks;
  return (
    match.qualificationWait === true &&
    sources !== undefined &&
    sources.length > 0 &&
    sources.every((source) => source.status === 'pending' && rulingIds.has(source.poolId))
  );
}

/** A work list of decisions and dispatch opportunities, not every unavailable match. */
export function opsAttention(data: AttentionData, renderedPools: readonly PoolScope[] = []) {
  const closed = ['complete', 'cancelled'].includes(data.plan.status);
  const byId = new Map(data.matches.map((match) => [match.id, match]));
  const renderedPoolKeys = new Set(renderedPools.map(poolKey));
  const poolRulings =
    closed || data.plan.drawPaused
      ? []
      : (data.poolOrders ?? []).filter(
          (order) =>
            order.plannerConfirmation?.available === true && renderedPoolKeys.has(poolKey(order)),
        );
  const rulingIds = new Set(poolRulings.map((pool) => pool.poolId));
  const reports = closed
    ? []
    : data.reports
        .filter((report) => report.status === 'pending')
        .map((report) => {
          const match = byId.get(report.matchId);
          return { ...report, match, stale: !match || match.revision !== report.expectedRevision };
        });
  const decisions = closed
    ? []
    : data.matches.filter((match) => {
        if (
          match.status !== 'blocked' ||
          normalWaits.has(match.blockedReason ?? '') ||
          waitsOnlyForPoolRulings(match, rulingIds)
        )
          return false;
        // Unknown qualifiers alone are normal bracket progress, not a TO decision.
        if ((!match.player1Id || !match.player2Id) && !match.blockedReason) return false;
        return true;
      });
  const dispatch = closed
    ? []
    : data.stationQueues.flatMap((queue) => {
        const station = data.stations.find((station) => station.id === queue.stationId);
        const match = queue.nextMatchId ? byId.get(queue.nextMatchId) : undefined;
        if (
          !station ||
          station.currentMatchId ||
          queue.currentMatchId ||
          !match ||
          !match.availability.canStart
        )
          return [];
        return [{ station, match }];
      });
  return {
    reports,
    decisions,
    poolRulings,
    dispatch,
    needsStations:
      !closed &&
      !data.stations.length &&
      (data.sharedDispatch?.capacity ?? 0) === 0 &&
      data.matches.some((match) => match.status === 'ready' || match.status === 'playing'),
  };
}

export function jumpToOpsControl(id: string) {
  const target = document.getElementById(id);
  let parent = target?.parentElement;
  while (parent) {
    if (parent.hasAttribute('data-disclosure')) parent.dispatchEvent(new Event('ui:expand'));
    parent = parent.parentElement;
  }
  requestAnimationFrame(() => {
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target?.focus({ preventScroll: true });
  });
}
