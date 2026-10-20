import { validateDivisionInput, type DivisionCandidate, type PlanIssue } from './divisions';
import type { PlanEntryView } from './contracts';
export function planIssues(
  entries: readonly PlanEntryView[],
  upperTargetSize: number | null,
  poolSize: number,
): { blocking: PlanIssue[]; warnings: PlanIssue[] } {
  const blocking: PlanIssue[] = [];
  const warnings: PlanIssue[] = [];

  const unresolved = entries.filter((entry) => entry.playerId === null);
  if (unresolved.length > 0) {
    blocking.push({
      code: 'unresolved_rows',
      message: `${unresolved.length} row(s) are not matched to a player yet.`,
      entryIds: unresolved.map((entry) => entry.id),
    });
  }

  const candidates: DivisionCandidate[] = entries
    .filter((entry) => entry.playerId !== null)
    .map((entry) => ({
      entryId: entry.id,
      playerId: entry.playerId!,
      divisionPreference: entry.divisionPreference,
      snapshotRank: entry.snapshotRank ?? entry.currentRank,
      sourceLineNumber: entry.sourceLineNumber,
    }));
  blocking.push(...validateDivisionInput(candidates, { upperTargetSize, poolSize }));

  // Two lines that cleaned to the same name but landed on different people is
  // usually a mis-correction, and is exactly the mistake that produces a bracket
  // with somebody's twin in it.
  const byCleanedName = new Map<string, PlanEntryView[]>();
  for (const entry of entries) {
    const key = entry.cleanedName.toLowerCase();
    byCleanedName.set(key, [...(byCleanedName.get(key) ?? []), entry]);
  }
  for (const [name, group] of byCleanedName) {
    const distinct = new Set(group.map((entry) => entry.playerId));
    if (group.length > 1 && distinct.size > 1) {
      warnings.push({
        code: 'same_name_different_players',
        message: `“${name}” appears on ${group.length} rows resolved to different players.`,
        entryIds: group.map((entry) => entry.id),
      });
    }
  }

  const structured = entries.filter((entry) => entry.resolutionMethod === 'structured');
  if (structured.length > 0) {
    warnings.push({
      code: 'structured_unconfirmed',
      message:
        `${structured.length} row(s) matched on a short form (“Josh C”) rather than an exact name. ` +
        'Worth a glance before freezing.',
      entryIds: structured.map((entry) => entry.id),
    });
  }

  const inactive = entries.filter((entry) => entry.playerStatus === 'merged');
  if (inactive.length > 0) {
    warnings.push({
      code: 'merged_player',
      message: `${inactive.length} row(s) point at a player that has been merged into another.`,
      entryIds: inactive.map((entry) => entry.id),
    });
  }

  const unrated = entries.filter((entry) => entry.playerId !== null && entry.currentRank === null);
  if (unrated.length > 0) {
    warnings.push({
      code: 'unrated_player',
      message: `${unrated.length} entrant(s) have no rating yet and will seed at the bottom of their division.`,
      entryIds: unrated.map((entry) => entry.id),
    });
  }

  return { blocking, warnings };
}
