import { Button } from './ui/Button';
import { ScoreFields, type ScoreInputValue } from './ScoreFields';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CompletedScoreReport, type ResultSubmission } from './CompletedScoreReport';
import type { GuestSession } from '../lib/guestReporting';
import { trpc } from '../lib/trpc';

type GuestData = Awaited<ReturnType<typeof trpc.eventOps.guests.matches.mutate>>;
export type GuestMatch = GuestData['matches'][number];

export function GuestScoreCard({
  planId,
  session,
  match,
  report,
  status,
  station,
  selfRun,
  autoAccept,
  disputeMode,
}: {
  planId: string;
  session: GuestSession | null;
  match: GuestMatch;
  report?: GuestData['reports'][number];
  status: string;
  station?: string;
  selfRun: boolean;
  autoAccept: boolean;
  disputeMode: boolean;
}) {
  const cache = useQueryClient();
  const [score1, setScore1] = useState<ScoreInputValue>(0);
  const [score2, setScore2] = useState<ScoreInputValue>(0);
  const [revision, setRevision] = useState(match.revision);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState<'approved' | 'pending' | null>(null);
  const [retryRejected, setRetryRejected] = useState(false);
  const [error, setError] = useState('');
  const stale = revision !== match.revision;
  const reset = () => {
    setRevision(match.revision);
    setScore1(0);
    setScore2(0);
    setRequestId(crypto.randomUUID());
    setError('');
    setSent(null);
  };
  const reportResult = async (input: ResultSubmission) => {
    if (!session) throw new Error('Scan a guest reporting QR to report a score.');
    const result = await trpc.eventOps.guests.submit.mutate({
      planId,
      sessionToken: session.sessionToken,
      matchId: match.id,
      ...input,
    });
    await Promise.all([
      cache.invalidateQueries({ queryKey: ['guestMatches', planId] }),
      cache.invalidateQueries({ queryKey: ['eventOpsPublic', planId] }),
    ]);
    return result;
  };
  const submit = async () => {
    if (!session || score1 === '' || score2 === '') return;
    setPending(true);
    setError('');
    try {
      const result = await trpc.eventOps.guests.submit.mutate({
        planId,
        sessionToken: session.sessionToken,
        matchId: match.id,
        expectedRevision: revision,
        requestId,
        score1,
        score2,
      });
      setSent(result.status === 'approved' ? 'approved' : 'pending');
      setRetryRejected(false);
      await Promise.all([
        cache.invalidateQueries({ queryKey: ['guestMatches', planId] }),
        cache.invalidateQueries({ queryKey: ['eventOpsPublic', planId] }),
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not send the score. Try again.');
    } finally {
      setPending(false);
    }
  };
  return (
    <article className="card ops-match">
      <div className="ops-match-meta">
        <span>
          {match.division} · {match.label}
        </span>
        <span>
          {status}
          {station ? ` · ${station}` : ''}
        </span>
      </div>
      <h3>
        {match.player1Name} vs {match.player2Name}
      </h3>
      {report && (
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
          enabled={Boolean(session)}
          allowReports={disputeMode && match.outcome === 'played'}
          onSubmit={reportResult}
          pendingReport={report?.status === 'pending' ? report : undefined}
        />
      ) : match.status === 'blocked' ? (
        <p>Waiting for earlier matches or a TO before this match can start.</p>
      ) : !session ? (
        <p>Scan a guest reporting QR to start matches and report scores.</p>
      ) : report?.status === 'pending' || (sent && !report) ? (
        <p>{sent === 'approved' ? 'Result confirmed.' : 'Thanks! A TO will review your score.'}</p>
      ) : report?.status === 'approved' ? (
        <p>Your report has been approved. Ask a TO if this match needs a correction.</p>
      ) : report?.status === 'rejected' && !retryRejected ? (
        <>
          <p>Check the score with a TO before submitting again.</p>
          <Button
            onClick={() => {
              reset();
              setRetryRejected(true);
            }}
          >
            Start a new report
          </Button>
        </>
      ) : selfRun && match.status !== 'playing' ? (
        <p className="pool-flow-selected-note">
          {status === 'Play next' ? (
            <>
              Start this match from its station’s <a href="#pool-station-queues">Play next card</a>{' '}
              first. Once it is playing, report the result here.
            </>
          ) : (
            'Wait for a station call before starting this match.'
          )}
        </p>
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
              pending ||
              stale ||
              score1 === '' ||
              score2 === '' ||
              score1 === score2 ||
              !['ready', 'playing'].includes(match.status)
            }
          >
            {disputeMode || (selfRun && autoAccept)
              ? 'Confirm result'
              : 'Submit score for TO approval'}
          </Button>
          <p className="muted">
            {disputeMode
              ? 'Results advance immediately. Later disagreements go to TO review.'
              : selfRun && autoAccept
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
