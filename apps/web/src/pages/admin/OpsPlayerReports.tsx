import { Button } from '../../components/ui/Button';
import { trpc } from '../../lib/trpc';
type Overview = Awaited<ReturnType<typeof trpc.eventOps.overview.query>>;
type Action = (work: () => Promise<unknown>, message?: string) => Promise<void>;
export function PlayerReports({
  data,
  disabled,
  act,
}: {
  data: Overview;
  disabled: boolean;
  act: Action;
}) {
  return (
    <section className="card" id="score-submissions">
      <h3>Score submissions</h3>
      <p className="muted">
        Review pending scores and disagreements. A conflicting report does not replace the recorded
        result until a TO accepts the correction.
      </p>
      <ReportRows data={data} disabled={disabled} act={act} />
    </section>
  );
}
function ReportRows({ data, disabled, act }: { data: Overview; disabled: boolean; act: Action }) {
  const reports = data.reports
    .filter((report) => report.status === 'pending')
    .sort((a, b) => Number(b.isDispute) - Number(a.isDispute));
  return reports.length ? (
    <div>
      {reports.map((report) => {
        const match = data.matches.find((match) => match.id === report.matchId);
        return (
          <div
            className="ops-report"
            key={report.id}
            id={`score-report-${report.id}`}
            tabIndex={-1}
          >
            <div>
              {report.isDispute && (
                <p className="error-text">
                  <strong>Conflicting report · TO review</strong>
                  <br />
                  {match?.status === 'complete' ? (
                    <>
                      Recorded result: {match.player1Name} {match.score1}–{match.score2}{' '}
                      {match.player2Name}. This report proposes:
                    </>
                  ) : (
                    'Conflicting submissions; no result recorded. This report proposes:'
                  )}
                </p>
              )}
              <strong>
                {match?.player1Name ?? 'Player'} {report.score1} – {report.score2}{' '}
                {match?.player2Name ?? 'Player'}
              </strong>
              <p className="muted">
                {match?.label} · {report.reporterLabel} report · {report.outcome}
                {match && match.revision !== report.expectedRevision
                  ? ' · stale: match has changed'
                  : ''}
              </p>
            </div>
            <Button
              size="small"
              type="submit"
              disabled={disabled || match?.revision !== report.expectedRevision}
              onClick={() =>
                void act(
                  () => trpc.eventOps.reviewReport.mutate({ reportId: report.id, approve: true }),
                  'Player score approved',
                )
              }
            >
              {report.isDispute ? 'Use submitted result' : 'Approve'}
            </Button>
            <Button
              size="small"
              type="submit"
              disabled={disabled}
              onClick={() =>
                void act(
                  () => trpc.eventOps.reviewReport.mutate({ reportId: report.id, approve: false }),
                  'Player report rejected',
                )
              }
            >
              {report.isDispute && match?.status === 'complete' ? 'Keep recorded result' : 'Reject'}
            </Button>
          </div>
        );
      })}
    </div>
  ) : (
    <p className="muted">No scores awaiting review.</p>
  );
}
export function AuditList({ data }: { data: Overview }) {
  return (
    <ol className="ops-audit-list">
      {data.audit.slice(0, 30).map((item) => (
        <li key={item.id}>
          <strong>{item.action.replaceAll('_', ' ')}</strong> ·{' '}
          {data.matches.find((match) => match.id === item.matchId)?.label ?? 'Event'}{' '}
          <time>{new Date(item.createdAt).toLocaleString()}</time>
        </li>
      ))}
    </ol>
  );
}
