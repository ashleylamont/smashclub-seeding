import { and, eq } from 'drizzle-orm';
import { ratingEvents, tournaments, type Db } from '@smashclub/db';
import {
  DISPLAY_CENTRE,
  NATURAL_TO_DISPLAY,
  buildWhrPriorEvidence,
  fitWhrPrefix,
  probabilityFromRatings,
  whrForecastUnavailable,
  whrSetSides,
} from '@smashclub/engine';
import { latestRecomputeId } from './recompute';
import {
  loadWhrHistoryThroughDay,
  readWhrRunProvenance,
  whrPrefixFingerprints,
} from './whrProvenance';

interface ImpactInput {
  playerId: string;
  setId: string;
  recomputeId: string;
}

type UnavailableReason =
  | 'stale_run'
  | 'older_run'
  | 'not_rated'
  | 'history_changed'
  | 'non_converged'
  | 'history_too_large'
  | 'busy';
const unavailable = (reason: UnavailableReason) => ({ status: 'unavailable' as const, reason });

const MAX_ACTIVE_READS = 2;
const WORK_PER_SECOND = { read: 24, refit: 4 };
const MAX_CACHE_ENTRIES = 256;
let activeReads = 0;
let windowStart = 0;
let work = { read: 0, refit: 0 };
const cache = new Map<string, ReadonlyMap<string, number>>();

function reserve(kind: keyof typeof WORK_PER_SECOND) {
  const now = Date.now();
  if (now < windowStart || now - windowStart >= 1000) {
    windowStart = now;
    work = { read: 0, refit: 0 };
  }
  if (work[kind] >= WORK_PER_SECOND[kind]) return false;
  work[kind]++;
  return true;
}

async function readSnapshot(db: Db, input: ImpactInput) {
  if ((await latestRecomputeId(db)) !== input.recomputeId) return unavailable('stale_run');
  const provenance = await readWhrRunProvenance(db, input.recomputeId);
  if (!provenance) return unavailable('older_run');
  const participants = await db
    .select({
      playerId: ratingEvents.playerId,
      postRating: ratingEvents.postRating,
      preRating: ratingEvents.preRating,
      preRd: ratingEvents.preRd,
      weight: ratingEvents.weight,
      eventDate: tournaments.eventDate,
    })
    .from(ratingEvents)
    .innerJoin(tournaments, eq(ratingEvents.tournamentId, tournaments.id))
    .where(
      and(
        eq(ratingEvents.recomputeId, input.recomputeId),
        eq(ratingEvents.setId, input.setId),
        eq(ratingEvents.isDecay, false),
      ),
    );
  const participant = participants.find(({ playerId }) => playerId === input.playerId);
  if (!participant || (participants.length !== 2 && participants.length !== 4))
    return unavailable('not_rated');
  if (!participant.eventDate) return unavailable('history_changed');
  const history = await loadWhrHistoryThroughDay(db, participant.eventDate, provenance.settings);
  if (!history) return unavailable('history_too_large');
  const setIndex = history.rateable.findIndex(({ set }) => set.id === input.setId);
  const row = history.rateable[setIndex];
  if (!row) return unavailable('history_changed');
  const members = whrSetSides(row.set).flat();
  if (
    members.length !== participants.length ||
    !members.every((id) => participants.some(({ playerId }) => playerId === id))
  )
    return unavailable('history_changed');
  if (whrPrefixFingerprints(history).get(row.eventKey) !== provenance.fingerprints[row.eventKey])
    return unavailable('history_changed');
  return { status: 'verified' as const, history, setIndex, row, participants, participant };
}

function meanPreRating(team: readonly { preRating: number }[]) {
  return team.reduce((sum, member) => sum + member.preRating, 0) / team.length;
}

function varianceOfMean(team: readonly { preRd: number }[]) {
  return (
    team.reduce((sum, member) => sum + (member.preRd / NATURAL_TO_DISPLAY) ** 2, 0) /
    team.length ** 2
  );
}

export async function readWhrResultImpact(db: Db, input: ImpactInput) {
  if (activeReads >= MAX_ACTIVE_READS || !reserve('read')) return unavailable('busy');
  activeReads++;
  try {
    // Read the canonical inputs and displayed recompute from one consistent snapshot.
    // A cache hit still checks provenance, so a correction cannot mix two runs.
    const snapshot = await db.transaction((tx) => readSnapshot(tx, input), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
    if (snapshot.status === 'unavailable') return snapshot;
    const { history, row, setIndex, participants, participant } = snapshot;
    const cacheKey = `${input.recomputeId}:${input.setId}`;
    let deltas = cache.get(cacheKey);
    if (deltas) cache.delete(cacheKey);
    else {
      if (!reserve('refit')) return unavailable('busy');
      // A completed recompute can contain an unconverged historical prefix.
      // Validate both fits and the published baseline before using the comparison.
      const included = fitWhrPrefix(history, row.eventKey);
      const without = fitWhrPrefix(history, row.eventKey, setIndex);
      if (!included.converged || !without.converged) return unavailable('non_converged');
      const time = row.day - history.originDay;
      if (
        participants.some(
          ({ playerId, postRating }) =>
            !Number.isFinite(postRating) ||
            Math.abs(included.display(playerId, time).rating - postRating) > 1e-6,
        )
      )
        return unavailable('history_changed');
      deltas = new Map(
        participants.map(({ playerId, postRating }) => [
          playerId,
          postRating -
            (without.latest(playerId)
              ? without.display(playerId, time).rating
              : DISPLAY_CENTRE + (history.priorMeans.get(playerId) ?? 0) * NATURAL_TO_DISPLAY),
        ]),
      );
    }
    cache.set(cacheKey, deltas);
    if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
    const evidence = buildWhrPriorEvidence(history, row.eventKey);
    const firstNight = !evidence.has(input.playerId);
    const sides = whrSetSides(row.set);
    const side = sides[0].includes(input.playerId) ? 0 : 1;
    const own = participants.filter(({ playerId }) => sides[side].includes(playerId));
    const other = participants.filter(({ playerId }) => !sides[side].includes(playerId));
    const forecastUnavailable = whrForecastUnavailable(evidence, participants);
    const forecast =
      forecastUnavailable === null
        ? {
            winProbability: probabilityFromRatings(
              (meanPreRating(own) - DISPLAY_CENTRE) / NATURAL_TO_DISPLAY,
              (meanPreRating(other) - DISPLAY_CENTRE) / NATURAL_TO_DISPLAY,
              varianceOfMean(own) + varianceOfMean(other),
            ),
            opponentSkill: meanPreRating(other),
          }
        : null;
    return {
      status: 'available' as const,
      effectPoints: deltas.get(input.playerId)!,
      preNightSd:
        Number.isFinite(participant.preRd) && participant.preRd > 0 ? participant.preRd : null,
      evidenceWeight: participant.weight,
      gamesWeight: history.gamesWeight,
      firstNight,
      forecast,
      forecastUnavailable,
    };
  } finally {
    activeReads--;
  }
}
