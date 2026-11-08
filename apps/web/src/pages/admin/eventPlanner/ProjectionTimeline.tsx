import { useState } from 'react';
import { Button } from '../../../components/ui/Button';
import { Disclosure } from '../../../components/ui/Disclosure';
import { ProjectionRunSheet } from './ProjectionRunSheet';
import { type FormatProjection, projectedTime } from './projectionView';
import {
  projectionColor,
  projectionDuration,
  projectionFeederName,
  projectionMatchName,
  projectionPairing,
  projectionTimelineName,
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
  const sections = new Map(
    [...projection.pools, ...projection.brackets].map(({ id, label }) => [id, label]),
  );
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
        {projection.brackets.length > 0 && <span>QF: quarter-final · SF: semi-final</span>}
        {projection.pools.length > 0 && <span>R/S: round/set</span>}
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
                  .map((match) => {
                    const name = projectionMatchName(match);
                    const pairing = projectionPairing(match, byId);
                    const section = sections.get(match.section);
                    const showSection = match.stage === 'group' || projection.brackets.length > 1;
                    const fullName = showSection && section ? `${name} · ${section}` : name;
                    const compactName = projectionTimelineName(match);
                    const compactSection = showSection
                      ? section
                          ?.replace(/^Upper /, 'U ')
                          .replace(/^Lower /, 'L ')
                          .replace(/^Open /, '')
                          .replace(/championship$/, 'champ')
                          .replace(/consolation$/, 'cons')
                      : undefined;
                    const barLabel = compactSection
                      ? `${compactName} ${compactSection}`
                      : compactName;
                    const accessibleName =
                      barLabel === fullName ? fullName : `${fullName} (${barLabel})`;
                    return (
                      <Button
                        key={match.id}
                        className={`projection-bar ${projectionColor(match)}${match.conditional ? ' projection-conditional' : ''}`}
                        style={{
                          left: match.startMinute * scale,
                          width: Math.max(3, (match.endMinute - match.startMinute) * scale),
                        }}
                        aria-label={`${accessibleName}: ${pairing.join(' versus ')}, ${projectedTime(start, match.startMinute)} to ${projectedTime(start, match.endMinute)}`}
                        aria-pressed={match.id === selectedId}
                        title={`${fullName}: ${pairing.join(' vs ')} · ${projectedTime(start, match.startMinute)}`}
                        onClick={() => setSelectedId(match.id)}
                      >
                        <span>{compactName}</span>
                        {compactSection && <span>{compactSection}</span>}
                      </Button>
                    );
                  })}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="projection-inspector" aria-live="polite">
        {selected ? (
          <p>
            <strong>
              {projectionMatchName(selected)} · {sections.get(selected.section) ?? selected.label}
            </strong>
            <br />
            {projectionPairing(selected, byId).join(' vs ')} · Station {selected.station} ·{' '}
            {projectedTime(start, selected.startMinute)}–{projectedTime(start, selected.endMinute)}
            {selected.dependsOn.length > 0 && (
              <>
                {' '}
                · After{' '}
                {selected.dependsOn
                  .map((id) => projectionFeederName(byId.get(id)!, selected.section, sections))
                  .join(' and ')}
              </>
            )}
          </p>
        ) : (
          <p className="muted">Select a set to inspect its pairing, station and feeder matches.</p>
        )}
      </div>
      <Disclosure className="projection-run-sheet" title="Provisional run sheet and CSV">
        <ProjectionRunSheet matches={played} start={start} byId={byId} sections={sections} />
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
