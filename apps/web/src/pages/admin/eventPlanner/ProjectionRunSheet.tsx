import { Button } from '../../../components/ui/Button';
import {
  projectionFeederName,
  projectionMatchCode,
  projectionMatchName,
  projectionPairing,
} from './projectionBracketLayout';
import { type ProjectedMatch, projectedTime } from './projectionView';

function csvLink(rows: string[][]) {
  const csv = rows
    .map((row) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(','))
    .join('\r\n');
  return `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
}

export function ProjectionRunSheet({
  matches,
  start,
  byId,
  sections,
}: {
  matches: ProjectedMatch[];
  start: string;
  byId: ReadonlyMap<string, ProjectedMatch>;
  sections: ReadonlyMap<string, string>;
}) {
  const rows = matches.map((match) => {
    const parents = match.dependsOn.map((id) => byId.get(id)!);
    return {
      match,
      code: projectionMatchCode(match),
      name: projectionMatchName(match),
      stage: sections.get(match.section) ?? match.label,
      timing: [
        String(match.station),
        projectedTime(start, match.startMinute),
        projectedTime(start, match.endMinute),
      ] as const,
      sides: projectionPairing(match, byId),
      after: parents.map((parent) => projectionFeederName(parent, match.section, sections)),
      afterCodes: parents.map(projectionMatchCode).join(' / '),
    };
  });
  // Keep the original file format and all source references for existing sheets.
  const sourceCsv = csvLink([
    ['Set', 'Stage', 'Station', 'Start', 'End', 'Side A', 'Side B', 'After'],
    ...rows.map(({ match, code, timing, afterCodes }) => [
      code,
      match.label,
      ...timing,
      ...projectionPairing(match, byId, 'code'),
      afterCodes,
    ]),
  ]);
  const namedCsv = csvLink([
    [
      'Match',
      'Stage',
      'Station',
      'Start',
      'End',
      'Side A',
      'Side B',
      'After',
      'Set reference',
      'After references',
    ],
    ...rows.map(({ name, stage, timing, sides, after, code, afterCodes }) => [
      name,
      stage,
      ...timing,
      ...sides,
      after.join(' / '),
      code,
      afterCodes,
    ]),
  ]);
  return (
    <>
      <div className="ui-actions">
        <Button asChild size="small">
          <a download="tournament-projection.csv" href={sourceCsv}>
            Download projected run sheet
          </a>
        </Button>
        <Button asChild size="small">
          <a download="tournament-projection-named.csv" href={namedCsv}>
            Download run sheet with match names
          </a>
        </Button>
      </div>
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
            {rows.map(({ match, name, stage, timing, sides, after }) => (
              <tr key={match.id}>
                <td>{name}</td>
                <td>{stage}</td>
                <td>{timing[0]}</td>
                <td>
                  {timing[1]}–{timing[2]}
                </td>
                <td>{sides.join(' vs ')}</td>
                <td>{after.join(', ') || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
