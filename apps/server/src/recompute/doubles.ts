import { nativeResultPublications, type Db } from '@smashclub/db';
import {
  fitDoubles,
  runWhrModel,
  NATURAL_TO_DISPLAY,
  type DoublesSet,
  type SkillEstimate,
} from '@smashclub/engine';
import { Result } from '../tournament/schemas';
import { historicalPlayerIds } from '../identity/playerIds';
import { loadSinglesHistory } from './inputs';
import { getRatingSettings } from '../settings';

/** Derived on demand from latest sealed revisions; doubles never changes the singles fit. */
export async function loadDoublesRatings(db: Db, before: number) {
  const { rating: settings } = await getRatingSettings(db);
  const { engineSets, engineTournaments } = await loadSinglesHistory(db);
  const canonical = await historicalPlayerIds(db);
  const publications = await db.select().from(nativeResultPublications);
  const latest = new Map<string, (typeof publications)[number]>();
  for (const p of publications)
    if ((latest.get(p.eventPlanId)?.revision ?? 0) < p.revision) latest.set(p.eventPlanId, p);
  const doubles: DoublesSet[] = [];
  const sourceResultIds: string[] = [];
  for (const publication of latest.values()) {
    const result = Result.parse(publication.result);
    if (
      result.competitionFormat !== 'doubles' ||
      Math.floor(result.eventDate / 86400000) >= Math.floor(before / 86400000)
    )
      continue;
    sourceResultIds.push(result.id);
    for (const match of result.matches) {
      if (match.outcome !== 'played' || !match.winnerId || !match.player1Id || !match.player2Id)
        continue;
      const a = result.entrants
        .find((e) => e.playerId === match.player1Id)
        ?.memberPlayerIds?.map(canonical);
      const b = result.entrants
        .find((e) => e.playerId === match.player2Id)
        ?.memberPlayerIds?.map(canonical);
      if (!a || !b || a.length !== 2 || b.length !== 2 || new Set([...a, ...b]).size !== 4)
        throw new Error(
          'Doubles history has invalid member identities; review the affected result.',
        );
      doubles.push({
        id: match.id,
        time: Math.floor(result.eventDate / 86400000),
        p1: [a[0]!, a[1]!],
        p2: [b[0]!, b[1]!],
        winner: match.winnerId === match.player1Id ? 1 : 2,
        p1Games: match.score1,
        p2Games: match.score2,
        outcome: 'played',
      });
    }
  }
  const byDay = new Map<number, Map<string, SkillEstimate>>();
  const skillAt = (id: string, time: number): SkillEstimate => {
    const day = Math.floor(time);
    if (!byDay.has(day)) {
      const ts = engineTournaments.filter(
        (t) => Math.floor(Date.parse(t.eventDate) / 86400000) < day,
      );
      const ids = new Set(ts.map((t) => t.id));
      const run = runWhrModel({
        sets: engineSets.filter((s) => ids.has(s.tournamentId)),
        tournaments: ts,
        settings: { ...settings, whrIsolationAnchor: false },
      });
      if (!run.converged) throw new Error('Singles prefix did not converge for doubles baselines.');
      const playedIds = new Set(
        engineSets.filter((s) => ids.has(s.tournamentId)).map((s) => s.tournamentId),
      );
      const played = ts.filter((t) => playedIds.has(t.id));
      const observedDay = played.length
        ? Math.max(...played.map((t) => Math.floor(Date.parse(t.eventDate) / 86400000)))
        : day;
      byDay.set(
        day,
        new Map(
          run.leaderboard.map((r) => [
            r.playerId,
            {
              rating: r.rating,
              sd: Math.sqrt(
                r.rd ** 2 +
                  Math.max(0, day - observedDay) *
                    settings.whrDriftVariancePerDay *
                    NATURAL_TO_DISPLAY ** 2,
              ),
            },
          ]),
        ),
      );
    }
    return (
      byDay.get(day)!.get(canonical(id)) ?? {
        rating: 1500,
        sd: settings.whrPriorSd * NATURAL_TO_DISPLAY,
      }
    );
  };
  const fit = fitDoubles({ sets: doubles, skillAt, gamesWeight: settings.whrGamesWeight });
  if (!fit.converged) throw new Error('Doubles WHR did not converge.');
  return {
    ...fit,
    skillAt,
    provenance: {
      model: 'whr-pair-residual-v1',
      priorSd: 0.25,
      driftVariancePerDay: 0.00002,
      baselineScale: 1,
      settings,
      sourceResultIds: sourceResultIds.sort(),
      beforeDay: Math.floor(before / 86400000),
    },
  };
}
