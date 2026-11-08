import { useRef } from 'react';
import { Link } from '@tanstack/react-router';
import type { PlayerEventView } from '../lib/apiTypes';
import { formatDate } from '../lib/format';
import { useWhrResultImpacts, type WhrResultImpact } from '../lib/useWhrResultImpacts';

const unavailableLabel = {
  stale_run: 'Refresh profile',
  older_run: 'Awaiting recompute',
  not_rated: 'Unavailable',
  history_changed: 'Awaiting recompute',
  non_converged: 'Unavailable',
  history_too_large: 'Unavailable',
  busy: 'Temporarily unavailable',
};

function impactLabel(impact: WhrResultImpact | undefined, active: boolean) {
  if (!impact) return active ? 'Estimating…' : '—';
  if (impact.status === 'error') return 'Unavailable';
  if (impact.status === 'unavailable') return unavailableLabel[impact.reason];
  const points = Math.abs(impact.effectPoints);
  if (points < 0.01) return 'Little change';
  const rounded = Math.round(points / 5) * 5;
  const higher = impact.effectPoints > 0;
  if (rounded === 0) return `<5 pts ${higher ? 'higher' : 'lower'}`;
  return `≈${higher ? '+' : '−'}${rounded} pts`;
}

function forecastDetails(impact: Extract<WhrResultImpact, { status: 'available' }>, won: boolean) {
  if (!impact.forecast) {
    if (impact.forecastUnavailable === 'first_night') {
      return { note: impact.firstNight ? 'First rated night' : 'Opponent’s first rated night' };
    }
    if (impact.forecastUnavailable === 'disconnected') return { note: 'Separate rated groups' };
    return { note: 'Estimate unavailable' };
  }
  const chance = Math.round(impact.forecast.winProbability * 100);
  const odds = chance === 0 ? '<1%' : chance === 100 ? '>99%' : `${chance}%`;
  const moreLikely = won ? chance > 50 : chance < 50;
  return {
    chance: `${odds} to win`,
    note: chance === 50 ? null : moreLikely ? 'More likely result' : 'Less likely result',
  };
}

const evidenceUnits = new Intl.NumberFormat('en-AU', { maximumFractionDigits: 2 });

export function PlayerMatchLog({
  events,
  playerId,
  recomputeId,
}: {
  events: readonly PlayerEventView[];
  playerId: string;
  recomputeId?: string | null;
}) {
  const body = useRef<HTMLTableSectionElement>(null);
  const { results, activeSetId, runFailure } = useWhrResultImpacts({
    body,
    events,
    playerId,
    recomputeId,
  });
  const runImpact = runFailure ? { status: 'unavailable' as const, reason: runFailure } : undefined;
  return (
    <div
      className="match-history-scroll table-scroll"
      role="region"
      aria-label="Match results"
      tabIndex={0}
    >
      <table className="match-table data-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Event</th>
            <th>Stage</th>
            <th>Opponent</th>
            <th>Result</th>
            <th className="num">Evidence</th>
          </tr>
        </thead>
        <tbody ref={body}>
          {events.map((event) => {
            const setId = recomputeId && !event.isDecay && event.won != null ? event.setId : null;
            const impact = setId ? (runImpact ?? results?.get(setId)) : undefined;
            const forecast =
              impact?.status === 'available' && event.won != null
                ? forecastDetails(impact, event.won)
                : null;
            return (
              <tr
                key={event.seq}
                data-whr-set-id={setId ?? undefined}
                className={event.isDecay ? 'decay' : event.won ? 'win' : 'loss'}
              >
                <td className="mono">{formatDate(event.tournamentDate)}</td>
                <td>
                  {event.tournamentName}
                  {event.isRookie && <span className="chip chip-warning rookie-chip">rookie</span>}
                  {setId && (
                    <span className="whr-impact-value">
                      WHR {impactLabel(impact, activeSetId === setId)}
                    </span>
                  )}
                  {setId && (
                    <span className="whr-impact-value whr-forecast">
                      {forecast && (
                        <>
                          WHR pre-night{forecast.chance && ` · ${forecast.chance}`}
                          {forecast.note && <span>{forecast.note}</span>}
                        </>
                      )}
                    </span>
                  )}
                </td>
                <td>{event.isDecay ? '—' : event.resultStage === 'group' ? 'Pool' : 'Bracket'}</td>
                <td>
                  {event.isDecay ? (
                    <em>Inactivity decay</em>
                  ) : event.opponentPlayerId ? (
                    <Link to="/players/$playerId" params={{ playerId: event.opponentPlayerId }}>
                      {event.opponentName ?? 'Unknown'}
                    </Link>
                  ) : (
                    (event.opponentName ?? 'Unknown')
                  )}
                </td>
                <td
                  className={
                    event.isDecay ? 'result-decay' : event.won ? 'result-win' : 'result-loss'
                  }
                >
                  {event.isDecay ? '—' : event.won ? 'W' : 'L'}
                </td>
                <td className="num">
                  {event.weight == null
                    ? '—'
                    : `${evidenceUnits.format(event.weight)} ${event.weight === 1 ? 'unit' : 'units'}`}
                  {impact?.status === 'available' && (
                    <span className="whr-impact-value">Margin weight {impact.gamesWeight}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
