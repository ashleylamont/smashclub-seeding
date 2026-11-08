import { and, eq } from 'drizzle-orm';
import { recomputes, ratingEvents, tournaments, type Db } from '@smashclub/db';
import {
  DISPLAY_CENTRE,
  NATURAL_TO_DISPLAY,
  fitWhrPrefix,
  prepareWhrHistory,
  probabilityFromRatings,
} from '@smashclub/engine';
import { ratingSettingsSchema } from '@smashclub/shared';
import { loadSinglesHistory } from './inputs';
import { latestRecomputeId } from './recompute';
import { currentWhrPrefixFingerprints, whrPrefixFingerprints } from './whrProvenance';

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
const HISTORY_LIMITS = { maxTournaments: 256, maxSets: 4000, maxNativeRows: 512 };
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
  const [run] = await db.select().from(recomputes).where(eq(recomputes.id, input.recomputeId));
  const fingerprints = currentWhrPrefixFingerprints(run?.stats);
  const snapshot = run?.settingsSnapshot as { rating?: unknown } | null;
  if (!fingerprints || !snapshot?.rating) return unavailable('older_run');
  const settings = ratingSettingsSchema.safeParse(snapshot.rating);
  if (!settings.success) return unavailable('older_run');
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
  if (!participant || participants.length !== 2) return unavailable('not_rated');
  if (!participant.eventDate) return unavailable('history_changed');
  const before = new Date(participant.eventDate);
  before.setUTCHours(24, 0, 0, 0);
  const inputs = await loadSinglesHistory(db, { before, ...HISTORY_LIMITS });
  if (!inputs) return unavailable('history_too_large');
  const { engineSets, engineTournaments } = inputs;
  const history = prepareWhrHistory({
    sets: engineSets,
    tournaments: engineTournaments,
    settings: settings.data,
  });
  const setIndex = history.rateable.findIndex(({ set }) => set.id === input.setId);
  const row = history.rateable[setIndex];
  if (!row) return unavailable('history_changed');
  if (whrPrefixFingerprints(history).get(row.eventKey) !== fingerprints[row.eventKey])
    return unavailable('history_changed');
  return { status: 'verified' as const, history, setIndex, row, participants, participant };
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
    const hasHistory = (playerId: string) =>
      history.rateable.some(
        ({ day, set }) =>
          day < row.day && (set.p1PlayerId === playerId || set.p2PlayerId === playerId),
      );
    const firstNight = !hasHistory(input.playerId);
    const opponent = participants.find(({ playerId }) => playerId !== input.playerId)!;
    const forecast =
      !firstNight &&
      hasHistory(opponent.playerId) &&
      participants.every(
        ({ preRating, preRd }) => Number.isFinite(preRating) && Number.isFinite(preRd) && preRd > 0,
      )
        ? {
            winProbability: probabilityFromRatings(
              (participant.preRating - DISPLAY_CENTRE) / NATURAL_TO_DISPLAY,
              (opponent.preRating - DISPLAY_CENTRE) / NATURAL_TO_DISPLAY,
              (participant.preRd / NATURAL_TO_DISPLAY) ** 2 +
                (opponent.preRd / NATURAL_TO_DISPLAY) ** 2,
            ),
            opponentSkill: opponent.preRating,
          }
        : null;
    return {
      status: 'available' as const,
      effectPoints: deltas.get(input.playerId)!,
      preNightSd:
        Number.isFinite(participant.preRd) && participant.preRd > 0 ? participant.preRd : null,
      evidenceWeight: participant.weight,
      firstNight,
      forecast,
    };
  } finally {
    activeReads--;
  }
}
