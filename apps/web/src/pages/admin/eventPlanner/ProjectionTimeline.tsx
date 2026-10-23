import { useState } from 'react';
import { Button } from '../../../components/ui/Button';
import { Disclosure } from '../../../components/ui/Disclosure';
import { type FormatProjection, type ProjectedMatch, projectedTime } from './projectionView';
import {
  projectionColor,
  projectionDuration,
  projectionMatchName,
  projectionPairing,
} from './projectionBracketLayout';

export function ProjectionTimeline({
  projection,
  stations,
  start,
}: {
  projection: FormatProjection;
  stations: number;
  start: string;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = projection.matches.find((m) => m.id === selectedId);
  const played = projection.matches.filter((m) => !m.bye);
  const byId = new Map(projection.matches.map((m) => [m.id, m]));
  const doubleElimination = projection.brackets.some((b) => b.kind === 'double_elimination');
  const width = Math.max(700, Math.min(6000, projection.totalMinutes * 5));
  const scale = width / Math.max(1, projection.totalMinutes);
  return (
    <>
      <p className="projection-legend">
        {doubleElimination ? (
          <>
            <span className="projection-de-winners">Winners bracket</span>
            <span className="projection-de-losers">Losers bracket</span>
            <span className="projection-de-final">Finals · reset if needed</span>
          </>
        ) : (
          <>
            <span className="projection-group">Pools</span>
            <span className="projection-main">Championship</span>
            <span className="projection-consolation">Consolation</span>
          </>
        )}
        <span>Empty space: turnaround, recovery or waiting for a feeder match.</span>
      </p>
      <div
        className="projection-scroll"
        role="region"
        aria-label="Projected station timeline"
        tabIndex={0}
      >
        <div className="projection-timeline" style={{ width: width + 100 }}>
          <div className="projection-axis" style={{ width }}>
            {Array.from({ length: 5 }, (_, i) => (
              <span key={i} style={{ left: `${i * 25}%` }}>
                {projectedTime(start, Math.round((projection.totalMinutes * i) / 4))}
              </span>
            ))}
          </div>
          {Array.from({ length: stations }, (_, i) => (
            <div className="projection-lane" key={i}>
              <strong>Station {i + 1}</strong>
              <div className="projection-track" style={{ width }}>
                {projection.pools.length > 0 &&
                  projection.brackets.some((b) => b.entrants >= 2) && (
                    <span
                      className="projection-stage-line"
                      aria-hidden="true"
                      style={{ left: projection.poolEndMinute * scale }}
                    />
                  )}
                {played
                  .filter((m) => m.station === i + 1)
                  .map((match) => (
                    <Button
                      key={match.id}
                      className={`projection-bar ${projectionColor(match)}${match.conditional ? ' projection-conditional' : ''}`}
                      style={{
                        left: match.startMinute * scale,
                        width: Math.max(3, (match.endMinute - match.startMinute) * scale),
                      }}
                      aria-label={`${projectionMatchName(match)}${match.conditional ? ' (if needed)' : ''}: ${projectionPairing(match, byId).join(' versus ')}, ${projectedTime(start, match.startMinute)} to ${projectedTime(start, match.endMinute)}`}
                      aria-pressed={match.id === selectedId}
                      title={`${match.label}: ${match.sides.join(' vs ')} · ${projectedTime(start, match.startMinute)}`}
                      onClick={() => setSelectedId(match.id)}
                    >
                      {projectionMatchName(match)}
                    </Button>
                  ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="projection-inspector" aria-live="polite">
        {selected ? (
          <p>
            <strong>
              {projectionMatchName(selected)} · {selected.label}
            </strong>
            <br />
            {projectionPairing(selected, byId).join(' vs ')} · Station {selected.station} ·{' '}
            {projectedTime(start, selected.startMinute)}–{projectedTime(start, selected.endMinute)}
            {selected.dependsOn.length > 0 && (
              <>
                {' '}
                · After{' '}
                {selected.dependsOn.map((id) => projectionMatchName(byId.get(id)!)).join(' and ')}
              </>
            )}
          </p>
        ) : (
          <p className="muted">Select a set to inspect its pairing, station and feeder matches.</p>
        )}
      </div>
      <Disclosure title="Provisional run sheet and CSV">
        <RunSheet matches={played} start={start} byId={byId} />
      </Disclosure>
      <p className="muted">
        {projection.pools.length > 0 ? (
          <>Pools finish at about {projectedTime(start, projection.poolEndMinute)}.</>
        ) : (
          <>Bracket play begins at {projectedTime(start, 0)}.</>
        )}
        {projection.pools.length > 0 && played.some((m) => m.stage !== 'group') && (
          <>
            {' '}
            Finals begin at about{' '}
            {projectedTime(
              start,
              Math.min(...played.filter((m) => m.stage !== 'group').map((m) => m.startMinute)),
            )}
            .
          </>
        )}{' '}
        Total play window: {projectionDuration(projection)}.
      </p>
    </>
  );
}

function RunSheet({
  matches,
  start,
  byId,
}: {
  matches: ProjectedMatch[];
  start: string;
  byId: Map<string, ProjectedMatch>;
}) {
  const csv = [
    ['Set', 'Stage', 'Station', 'Start', 'End', 'Side A', 'Side B', 'After'],
    ...matches.map((m) => [
      projectionMatchName(m),
      m.label,
      String(m.station),
      projectedTime(start, m.startMinute),
      projectedTime(start, m.endMinute),
      ...projectionPairing(m, byId),
      m.dependsOn.map((id) => projectionMatchName(byId.get(id)!)).join(' / '),
    ]),
  ]
    .map((row) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(','))
    .join('\r\n');
  return (
    <>
      <a
        className="btn btn-small"
        download="tournament-projection.csv"
        href={`data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`}
      >
        Download projected run sheet
      </a>
      <div
        className="projection-scroll"
        role="region"
        aria-label="Projected run sheet"
        tabIndex={0}
      >
        <table className="data-table">
          <caption>Approximate run order; changes with results and set lengths</caption>
          <thead>
            <tr>
              <th>Set</th>
              <th>Stage</th>
              <th>Station</th>
              <th>Time</th>
              <th>Pairing</th>
              <th>After</th>
            </tr>
          </thead>
          <tbody>
            {matches.map((m) => (
              <tr key={m.id}>
                <td>{projectionMatchName(m)}</td>
                <td>{m.label}</td>
                <td>{m.station}</td>
                <td>
                  {projectedTime(start, m.startMinute)}–{projectedTime(start, m.endMinute)}
                </td>
                <td>{projectionPairing(m, byId).join(' vs ')}</td>
                <td>
                  {m.dependsOn.map((id) => projectionMatchName(byId.get(id)!)).join(', ') || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
