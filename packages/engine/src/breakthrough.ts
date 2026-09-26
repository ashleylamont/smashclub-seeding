import type { GlickoSettings } from '@smashclub/shared';
import { eventKeyOf } from './events';
import { replayRatings } from './replay';
import { compareNullableNumbers, compareSetsInBracket, compareStrings } from './setOrder';
import type { EngineSet, EngineTournament } from './types';
import { DISPLAY_CENTRE, NATURAL_TO_DISPLAY, fitWhr, probabilityFromRatings, whrSetTrials } from './whr';

export interface BreakthroughSet {
  setId: string;
  tournamentId: string;
  opponentId: string;
  won: boolean;
  /** Null when either player has no pre-night history. */
  expected: number | null;
  opponentPriorNights: number;
}

export interface BreakthroughRow {
  playerId: string;
  priorNights: number;
  priorSets: number;
  baseline: { rating: number; sd: number } | null;
  sets: BreakthroughSet[];
}

/**
 * TO decision support, not an award selector. Fit strictly before the selected
 * event day: neither live results nor later events can influence expectations.
 * Tonight every set counts once, regardless of margin or bracket length.
 */
export function breakthroughEvidence(input: {
  eventKey: string;
  tournaments: readonly EngineTournament[];
  sets: readonly EngineSet[];
  settings: GlickoSettings;
}) {
  const { eventKey, settings } = input;
  const tournaments = new Map(input.tournaments.map((t) => [t.id, t]));
  const ordered = input.sets.filter((s) => tournaments.has(s.tournamentId) && s.p1PlayerId !== s.p2PlayerId)
    .sort((a, b) => {
      const ta = tournaments.get(a.tournamentId)!;
      const tb = tournaments.get(b.tournamentId)!;
      return compareStrings(ta.eventDate, tb.eventDate) || compareNullableNumbers(ta.challongeId, tb.challongeId)
        || compareStrings(ta.id, tb.id) || compareSetsInBracket(a, b);
    });
  const training = ordered.filter((s) => eventKeyOf(tournaments.get(s.tournamentId)!.eventDate) < eventKey);
  const tonight = ordered.filter((s) => eventKeyOf(tournaments.get(s.tournamentId)!.eventDate) === eventKey);
  const history = new Map<string, { sets: number; nights: Set<string> }>();
  const priorMeans = new Map<string, number>();
  for (const s of training) {
    const t = tournaments.get(s.tournamentId)!;
    for (const id of [s.p1PlayerId, s.p2PlayerId]) {
      if (!history.has(id)) priorMeans.set(id, t.isRookie ? (settings.whrRookieDebutPrior - DISPLAY_CENTRE) / NATURAL_TO_DISPLAY : 0);
      const h = history.get(id) ?? { sets: 0, nights: new Set<string>() };
      h.sets++;
      h.nights.add(eventKeyOf(t.eventDate));
      history.set(id, h);
    }
  }

  let baseline: (id: string) => { rating: number; sd: number } | null;
  let converged = true;
  if (settings.activeModel === 'whr') {
    const day = (date: string) => Math.floor(Date.parse(date) / 86_400_000);
    const fit = fitWhr({
      sets: training.map((s) => ({ ...s, time: day(tournaments.get(s.tournamentId)!.eventDate), trials: whrSetTrials(s, settings.whrGamesWeight) })),
      priorMeans,
      config: { priorSd: settings.whrPriorSd, driftVariancePerDay: settings.whrDriftVariancePerDay },
    });
    converged = fit.converged;
    baseline = (id) => history.has(id) ? fit.display(id, day(eventKey)) : null;
  } else {
    const replay = replayRatings({
      sets: training,
      tournaments: input.tournaments.filter((t) => eventKeyOf(t.eventDate) < eventKey),
      settings,
    });
    baseline = (id) => {
      const state = replay.finalStates.get(id);
      return state ? { rating: state.rating, sd: state.rd } : null;
    };
  }

  const rows = new Map<string, BreakthroughRow>();
  for (const s of tonight) {
    const a = baseline(s.p1PlayerId);
    const b = baseline(s.p2PlayerId);
    // Both uncertainties attenuate the prediction; club attendance penalties
    // and conservative seeding scores never enter the comparison.
    const p = a && b ? probabilityFromRatings(
      (a.rating - DISPLAY_CENTRE) / NATURAL_TO_DISPLAY,
      (b.rating - DISPLAY_CENTRE) / NATURAL_TO_DISPLAY,
      (a.sd / NATURAL_TO_DISPLAY) ** 2 + (b.sd / NATURAL_TO_DISPLAY) ** 2,
    ) : null;
    for (const [id, opponentId, won, expected] of [
      [s.p1PlayerId, s.p2PlayerId, s.winner === 1, p],
      [s.p2PlayerId, s.p1PlayerId, s.winner === 2, p === null ? null : 1 - p],
    ] as const) {
      const h = history.get(id);
      const row = rows.get(id) ?? { playerId: id, priorNights: h?.nights.size ?? 0, priorSets: h?.sets ?? 0, baseline: baseline(id), sets: [] };
      row.sets.push({ setId: s.id, tournamentId: s.tournamentId, opponentId, won, expected, opponentPriorNights: history.get(opponentId)?.nights.size ?? 0 });
      rows.set(id, row);
    }
  }
  return { model: settings.activeModel, converged, rows: [...rows.values()] };
}
