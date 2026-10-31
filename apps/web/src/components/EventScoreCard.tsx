import { matchPresentation } from '../lib/matchPresentation';
import { qualificationSummary } from '../lib/qualification';
import type { LiveMatch } from '../lib/eventDisplay';
import { useReportFeedback } from '../lib/useReportFeedback';
import { Button } from './ui/Button';
import { ScoreFields, type ScoreInputValue } from './ScoreFields';
import { useState } from 'react';
import { CompletedScoreReport, type ResultSubmission } from './CompletedScoreReport';
import type { PoolFlowMatch, ScoreApprovalPolicy } from '../lib/poolFlow';
import type { trpc } from '../lib/trpc';

type GuestData = Awaited<ReturnType<typeof trpc.eventOps.guests.matches.mutate>>;
export type GuestMatch = GuestData['matches'][number];

export function EventScoreCard({
  enabled,
  reportingIdentity = 'reporter',
  unavailableMessage = 'Scan a guest reporting QR to start matches and report scores.',
  onSubmit,
  pendingMessage = 'Thanks! A TO will review your score.',
  match,
  report,
  status,
  station,
  approvalPolicy,
  nextMatch,
}: {
  enabled: boolean;
  reportingIdentity?: string;
  unavailableMessage?: string;
  pendingMessage?: string;
  onSubmit: (input: ResultSubmission) => Promise<{ status: string; isDispute: boolean }>;
  match: PoolFlowMatch & { pendingDisputeCount?: number };
  report?: GuestData['reports'][number];
  status: string;
  station?: string;
  approvalPolicy: ScoreApprovalPolicy;
  nextMatch?: LiveMatch;
}) {
  const presentation = matchPresentation(match);
  const qualification = qualificationSummary(match);
  const [score1, setScore1] = useState<ScoreInputValue>(0);
  const [score2, setScore2] = useState<ScoreInputValue>(0);
  const [revision, setRevision] = useState(match.revision);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const { pending, sent, error, begin, update } = useReportFeedback(reportingIdentity);
  const [retryRejectedFor, setRetryRejectedFor] = useState<string | null>(null);
  const retryRejected = retryRejectedFor === reportingIdentity;
  const stale = revision !== match.revision;
  const reset = () => {
    setRevision(match.revision);
    setScore1(0);
    setScore2(0);
    setRequestId(crypto.randomUUID());
    update({ error: '', sent: null });
  };
  const submit = async () => {
    if (!enabled || score1 === '' || score2 === '') return;
    begin();
    try {
      const result = await onSubmit({
        expectedRevision: revision,
        requestId,
        score1,
        score2,
      });
      update({ sent: result.status === 'approved' ? 'approved' : 'pending' });
      setRetryRejectedFor((previous) => (previous === reportingIdentity ? null : previous));
    } catch (cause) {
      update({
        error: cause instanceof Error ? cause.message : 'Could not send the score. Try again.',
      });
    } finally {
      update({ pending: false });
    }
  };
  return (
    <article className="card ops-match">
      <div className="ops-match-meta">
        <span>
          {match.division} · {match.label}
        </span>
        <span>
          {presentation.status ?? status}
          {station ? ` · ${station}` : ''}
        </span>
      </div>
      <h3>{presentation.title}</h3>
      {qualification && presentation.kind === 'scheduled' && match.status !== 'blocked' && (
        <p role="status">{qualification} Your recorded pairing is unchanged.</p>
      )}
      {nextMatch && (
        <p>
          Next: {nextMatch.label} · {matchPresentation(nextMatch).title}
        </p>
      )}
      {report && ['played', 'scheduled'].includes(presentation.kind) && (
        <p className="guest-report-status" role="status">
          Your report: {report.score1} – {report.score2} ·{' '}
          {report.status === 'approved'
            ? 'Confirmed result'
            : report.status === 'rejected'
              ? 'Rejected by a TO'
              : report.isDispute
                ? 'Different score awaiting TO review'
                : 'Awaiting TO approval'}
        </p>
      )}
      {match.status === 'complete' ? (
        <CompletedScoreReport
          match={match}
          reportingIdentity={reportingIdentity}
          enabled={enabled}
          allowReports={approvalPolicy !== 'review' && presentation.canReport}
          onSubmit={onSubmit}
          pendingReport={report?.status === 'pending' ? report : undefined}
        />
      ) : presentation.kind === 'no-contest' ? (
        <p>{presentation.result}</p>
      ) : presentation.kind === 'pending' ? (
        <p>
          {presentation.result ?? 'Awaiting opponent. The next entrant has not been confirmed yet.'}
        </p>
      ) : match.status === 'blocked' ? (
        <p>{qualification ?? 'Waiting for earlier matches or a TO before this match can start.'}</p>
      ) : !enabled ? (
        <p>{unavailableMessage}</p>
      ) : report?.status === 'pending' || (sent && !report) ? (
        <p role="status">{sent === 'approved' ? 'Result confirmed.' : pendingMessage}</p>
      ) : report?.status === 'approved' ? (
        <p>Your report has been approved. Ask a TO if this match needs a correction.</p>
      ) : report?.status === 'rejected' && !retryRejected ? (
        <>
          <p>Check the score with a TO before submitting again.</p>
          <Button
            onClick={() => {
              setRevision(match.revision);
              setRequestId(crypto.randomUUID());
              update({ error: '', sent: null });
              setRetryRejectedFor(reportingIdentity);
            }}
          >
            Start a new report
          </Button>
        </>
      ) : (
        <form
          className="ops-score-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {stale && (
            <div role="alert">
              <p>
                Match details changed. Reload the match and check the players before submitting.
              </p>
              <Button type="button" onClick={reset}>
                Reload match
              </Button>
            </div>
          )}
          <ScoreFields
            player1Name={match.player1Name}
            player2Name={match.player2Name}
            score1={score1}
            score2={score2}
            onScore1={(value) => {
              setScore1(value);
              setRequestId(crypto.randomUUID());
            }}
            onScore2={(value) => {
              setScore2(value);
              setRequestId(crypto.randomUUID());
            }}
          />
          <Button
            type="submit"
            pending={pending}
            variant="primary"
            disabled={
              !enabled ||
              pending ||
              stale ||
              score1 === '' ||
              score2 === '' ||
              score1 === score2 ||
              !match.player1Id ||
              !match.player2Id ||
              !['ready', 'playing'].includes(match.status)
            }
          >
            {approvalPolicy !== 'review' ? 'Confirm result' : 'Submit score for TO approval'}
          </Button>
          <p className="muted">
            {approvalPolicy === 'event'
              ? 'Results advance immediately. Later disagreements go to TO review.'
              : approvalPolicy === 'pool'
                ? 'This pool confirms submitted results immediately. Check the players and final score together.'
                : 'A TO checks this score before it becomes a confirmed result.'}{' '}
            For forfeits, byes or corrections, ask a TO.
          </p>
        </form>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}
