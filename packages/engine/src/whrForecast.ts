import { whrSetSides, type PreparedWhrHistory } from './whrRun';

/** Players in the same component of earlier rated results can be compared. */
export type WhrPriorEvidence = ReadonlyMap<string, string>;

export function buildWhrPriorEvidence(
  history: PreparedWhrHistory,
  eventKey: string,
): WhrPriorEvidence {
  const parents = new Map<string, string>();

  function root(playerId: string): string {
    let parent = parents.get(playerId);
    while (parent !== undefined && parent !== playerId) {
      const grandparent = parents.get(parent) ?? parent;
      parents.set(playerId, grandparent);
      playerId = grandparent;
      parent = parents.get(playerId);
    }
    return playerId;
  }

  // A played set connects all its members, including the two sides of a
  // doubles set. Component labels only need to be equal within the group.
  for (const { eventKey: playedDay, set } of history.rateable) {
    if (playedDay >= eventKey) break;
    const members = whrSetSides(set).flat();
    const group = root(members[0]!);
    for (const playerId of members) parents.set(root(playerId), group);
  }
  for (const playerId of parents.keys()) parents.set(playerId, root(playerId));
  return parents;
}

interface ForecastEstimate {
  playerId: string;
  preRating: number;
  preRd: number;
}

export function whrForecastUnavailable(
  evidence: WhrPriorEvidence,
  participants: readonly ForecastEstimate[],
): 'first_night' | 'disconnected' | 'missing_estimate' | null {
  if (participants.some(({ playerId }) => !evidence.has(playerId))) return 'first_night';
  const first = participants[0];
  if (!first) return 'missing_estimate';
  const group = evidence.get(first.playerId);
  if (participants.some(({ playerId }) => evidence.get(playerId) !== group)) return 'disconnected';
  if (
    !participants.every(
      ({ preRating, preRd }) => Number.isFinite(preRating) && Number.isFinite(preRd) && preRd > 0,
    )
  )
    return 'missing_estimate';
  return null;
}
