import { and, inArray, isNotNull, lt } from 'drizzle-orm';
import { players, sets, tournamentParticipants, tournaments, type Db } from '@smashclub/db';
import { breakthroughEvidence, eventKeyOf, parseScoresCsv, type EngineSet } from '@smashclub/engine';
import { eventNameOf, includesResultStage, publicPlayerName, scoresIndicateUnplayed } from '@smashclub/shared';
import { getGlickoSettings } from '../settings';

/** Read directly from synced sets so live analysis never waits for recompute. */
export async function loadBreakthrough(db: Db, eventKey: string) {
  const nextDay = new Date(`${eventKey}T00:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const brackets = await db.select().from(tournaments)
    .where(and(isNotNull(tournaments.eventDate), lt(tournaments.eventDate, nextDay)));
  const night = brackets.filter((t) => eventKeyOf(t.eventDate!.toISOString()) === eventKey);
  if (!night.length) return null;
  const nightIds = new Set(night.map((t) => t.id));
  const modes = new Map(brackets.map((t) => [t.id, t.resultsMode]));
  const source = await db.select().from(sets).where(inArray(sets.tournamentId, brackets.map((t) => t.id)));
  const coverage = { pending: 0, excluded: 0, unlinked: 0, played: 0 };
  const usable: EngineSet[] = [];
  const setMeta = new Map<string, { p1: string; games: [number, number] | null; stage: 'group' | 'final' }>();
  for (const s of source) {
    const isTonight = nightIds.has(s.tournamentId);
    if (s.excludedFromRatings || scoresIndicateUnplayed(s.scoresCsv) || !includesResultStage(modes.get(s.tournamentId)!, s.resultStage)) {
      if (isTonight) coverage.excluded++;
      continue;
    }
    if (s.state !== 'complete' || (s.winner !== 1 && s.winner !== 2)) {
      if (isTonight) coverage.pending++;
      continue;
    }
    if (!s.p1PlayerId || !s.p2PlayerId || s.p1PlayerId === s.p2PlayerId) {
      if (isTonight) coverage.unlinked++;
      continue;
    }
    const score = parseScoresCsv(s.scoresCsv);
    usable.push({ ...s, p1PlayerId: s.p1PlayerId, p2PlayerId: s.p2PlayerId, winner: s.winner,
      completedAt: s.completedAt?.toISOString() ?? null, p1Games: score.unknown ? null : score.p1, p2Games: score.unknown ? null : score.p2 });
    if (isTonight) {
      coverage.played++;
      setMeta.set(s.id, { p1: s.p1PlayerId, games: score.unknown ? null : [score.p1, score.p2], stage: s.resultStage });
    }
  }
  const { glicko, version } = await getGlickoSettings(db);
  const evidence = breakthroughEvidence({ eventKey, sets: usable,
    tournaments: brackets.map((t) => ({ ...t, eventDate: t.eventDate!.toISOString() })), settings: glicko });
  const names = await db.select({ id: players.id, canonicalName: players.canonicalName, displayName: players.displayName }).from(players);
  const nameById = new Map(names.map((p) => [p.id, publicPlayerName(p)]));
  const entrants = await db.select({ playerId: tournamentParticipants.playerId }).from(tournamentParticipants)
    .where(inArray(tournamentParticipants.tournamentId, [...nightIds]));
  const participantsWithResults = new Set(evidence.rows.map((r) => r.playerId));
  const withoutResults = [...new Set(entrants.flatMap((p) => p.playerId && !participantsWithResults.has(p.playerId) ? [p.playerId] : []))];
  return {
    eventKey, name: eventNameOf(night.map((t) => t.name)), model: evidence.model, converged: evidence.converged,
    settingsVersion: version, checkedAt: new Date().toISOString(),
    complete: night.every((t) => t.challongeState === 'complete' && t.syncState === 'synced') && coverage.pending === 0,
    coverage,
    brackets: night.map((t) => ({ id: t.id, name: t.name, slug: t.challongeSlug, lastSyncedAt: t.lastSyncedAt?.toISOString() ?? null,
      liveUntil: t.liveUntil?.toISOString() ?? null, syncState: t.syncState })),
    withoutResults: withoutResults.map((id) => ({ playerId: id, name: nameById.get(id) ?? 'Unknown player' })),
    unresolvedEntrants: entrants.filter((p) => !p.playerId).length,
    rows: evidence.rows.map((r) => ({ ...r, name: nameById.get(r.playerId) ?? 'Unknown player',
      sets: r.sets.map((s) => {
        const meta = setMeta.get(s.setId)!;
        const games = meta.games && (r.playerId === meta.p1 ? meta.games : [meta.games[1], meta.games[0]]);
        return { ...s, score: games ? games.join('–') : null, stage: meta.stage, opponentName: nameById.get(s.opponentId) ?? 'Unknown player' };
      }) })),
  };
}
