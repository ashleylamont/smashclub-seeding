import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { trpc } from '../../lib/trpc';
import { returnUntakenCallMatchIds } from '../../lib/eventErrors';
import { matchPresentation } from '../../lib/matchPresentation';
import { UntakenCallRecovery, type UntakenCallDesk } from './UntakenCallRecovery';
type Overview = Awaited<ReturnType<typeof trpc.eventOps.overview.query>>;
type Action = (work: () => Promise<unknown>, message?: string) => Promise<void>;
export function PlayerReports({
  data,
  disabled,
  act,
  callDesk,
}: {
  data: Overview;
  disabled: boolean;
  act: Action;
  callDesk: UntakenCallDesk;
}) {
  return (
    <section
      className="card"
      id="score-submissions"
      aria-labelledby="score-submissions-title"
      tabIndex={-1}
    >
      <h3 id="score-submissions-title">Score submissions</h3>
      <ReportRows data={data} disabled={disabled} act={act} callDesk={callDesk} />
    </section>
  );
}
function ReportRows({ data, disabled, act, callDesk }: Parameters<typeof PlayerReports>[0]) {
  const [callConflict, setCallConflict] = useState<{ reportId: string; matchIds: string[] }>();
  const reports = data.reports
    .filter((report) => report.status === 'pending')
    .sort((a, b) => Number(b.isDispute) - Number(a.isDispute));
  return reports.length ? (
    <div>
      {reports.map((report) => {
        const match = data.matches.find((match) => match.id === report.matchId);
        const recordedOutcome = report.isDispute && match && matchPresentation(match, true).result;
        return (
          <div
            className="ops-report"
            key={report.id}
            id={`score-report-${report.id}`}
            tabIndex={-1}
          >
            <div>
              {report.isDispute && (
                <>
                  <p className="error-text">
                    <strong>Conflicting report</strong>
                  </p>
                  <p>
                    {recordedOutcome ? (
                      <>Recorded outcome · {recordedOutcome}</>
                    ) : match?.status === 'complete' ? (
                      <>
                        Recorded result · {match.player1Name} {match.score1}–{match.score2}{' '}
                        {match.player2Name}
                      </>
                    ) : (
                      'No result recorded.'
                    )}
                  </p>
                </>
              )}
              <strong>
                {report.isDispute ? 'Submitted result · ' : 'Pending score · '}
                {match?.player1Name ?? 'Player'} {report.score1} – {report.score2}{' '}
                {match?.player2Name ?? 'Player'}
              </strong>
              <p className="muted">
                {match?.label} · {report.reporterLabel} report · {report.outcome}
                {match && match.revision !== report.expectedRevision
                  ? ' · stale: match has changed'
                  : ''}
              </p>
              {callConflict?.reportId === report.id &&
                match?.revision === report.expectedRevision && (
                  <UntakenCallRecovery matchIds={callConflict.matchIds} desk={callDesk} />
                )}
            </div>
            <Button
              size="small"
              type="submit"
              disabled={disabled || match?.revision !== report.expectedRevision}
              onClick={() =>
                void act(async () => {
                  try {
                    await trpc.eventOps.reviewReport.mutate({ reportId: report.id, approve: true });
                  } catch (cause) {
                    setCallConflict({
                      reportId: report.id,
                      matchIds: returnUntakenCallMatchIds(cause),
                    });
                    throw cause;
                  }
                }, 'Player score approved')
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
