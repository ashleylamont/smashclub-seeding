import { Button } from '../../components/ui/Button';
import { Textarea } from '../../components/ui/Input';
import { Disclosure } from '../../components/ui/Disclosure';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { trpc } from '../../lib/trpc';
type Overview = Awaited<ReturnType<typeof trpc.eventOps.overview.query>>;
export function ScoreHandoff({
  planId,
  data,
  disabled,
}: {
  planId: string;
  data: Overview;
  disabled: boolean;
}) {
  const cache = useQueryClient();
  const capability = useQuery({
    queryKey: ['eventOpsDelivery', planId],
    queryFn: () => trpc.eventOps.delivery.status.query({ planId }),
  });
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const refresh = async () => {
    setPending('refresh');
    setError('');
    setNotice('');
    try {
      const result = await trpc.eventOps.sources.refresh.mutate({ planId });
      const failures = result.brackets.filter((bracket) => bracket.status === 'failed');
      setNotice(`${result.brackets.length - failures.length} linked bracket(s) refreshed.`);
      setError(
        [...failures.map((bracket) => `${bracket.slug}: ${bracket.error}`), result.queue.error]
          .filter(Boolean)
          .join(' '),
      );
      await cache.invalidateQueries({ queryKey: ['eventOps', planId] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to refresh brackets.');
    } finally {
      setPending(null);
    }
  };
  const reconcile = async (match: Overview['matches'][number]) => {
    setPending(match.id);
    setError('');
    setNotice('');
    try {
      const result = await trpc.eventOps.delivery.reconcile.mutate({
        matchId: match.id,
        expectedRevision: match.revision,
      });
      setNotice(result.message ?? 'Interrupted delivery checked.');
      await cache.invalidateQueries({ queryKey: ['eventOps', planId] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to check interrupted delivery.');
    } finally {
      setPending(null);
    }
  };
  const undelivered = data.matches.filter(
    (match) => match.status === 'complete' && match.syncState !== 'synced',
  );
  const summary = undelivered
    .map(
      (match) =>
        `${match.label}: ${match.player1Name} ${match.score1 ?? '–'} – ${match.score2 ?? '–'} ${match.player2Name} (${match.outcome ?? 'result'}; ${match.syncState})`,
    )
    .join('\n');
  const deliver = async (match: Overview['matches'][number]) => {
    setPending(match.id);
    setError('');
    setNotice('');
    try {
      const result = await trpc.eventOps.delivery.deliver.mutate({
        matchId: match.id,
        expectedRevision: match.revision,
      });
      if (result.ok) setNotice('Challonge confirmed the score.');
      else setError(result.message ?? 'Delivery needs reconciliation.');
      await cache.invalidateQueries({ queryKey: ['eventOps', planId] });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Delivery failed. Refresh and reconcile before retrying.',
      );
    } finally {
      setPending(null);
    }
  };
  return (
    <section className="card">
      <h3>
        Challonge handoff <span className="chip">{undelivered.length} local result(s)</span>
      </h3>
      <p className="muted">
        Local scores are retained here. Linked brackets remain the official bracket record. Refresh
        all linked brackets after a manual update to reconcile their results.
      </p>
      <Button
        type="submit"
        disabled={disabled || pending !== null || !data.brackets.some((bracket) => bracket.slug)}
        onClick={() => void refresh()}
      >
        {pending === 'refresh' ? 'Reading linked brackets…' : 'Refresh all linked brackets'}
      </Button>
      <div className="ops-links">
        {data.brackets
          .filter((bracket) => bracket.slug)
          .map((bracket) => (
            <a
              key={`${bracket.division}:${bracket.stage}`}
              href={`https://challonge.com/${encodeURIComponent(bracket.slug!)}`}
              target="_blank"
              rel="noreferrer"
            >
              {bracket.division} {bracket.stage} ↗
            </a>
          ))}
      </div>
      {!capability.data?.enabled && (
        <p className="muted">
          Direct score delivery is disabled. The manual handoff below is always available.
        </p>
      )}
      {capability.data?.enabled && !capability.data.hasCredentials && (
        <p className="error-text">Direct delivery needs configured Challonge credentials.</p>
      )}
      {undelivered.length > 0 && (
        <>
          <label className="ops-copy-label">
            Results to reconcile
            <Textarea rows={5} readOnly value={summary} />
          </label>
          <Button
            type="submit"
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob([`${data.plan.name}\n\n${summary}\n`], { type: 'text/plain' }),
              );
              const link = document.createElement('a');
              link.href = url;
              link.download = 'nemesis-score-handoff.txt';
              link.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            Download score handoff
          </Button>
        </>
      )}
      {capability.data?.enabled && capability.data.hasCredentials && (
        <div>
          {undelivered
            .filter((match) => match.outcome === 'played' && match.sourceSetId)
            .map((match) => (
              <div className="ops-report" key={match.id}>
                <span>
                  {match.label}: {match.score1}–{match.score2}
                </span>
                <Button
                  size="small"
                  type="submit"
                  disabled={disabled || pending !== null}
                  onClick={() => void deliver(match)}
                >
                  {pending === match.id ? 'Verifying delivery…' : 'Send to Challonge'}
                </Button>
              </div>
            ))}
        </div>
      )}
      {capability.data?.hasCredentials && (
        <Disclosure title="Recover an interrupted score delivery">
          <p className="muted">
            Reads Challonge to check whether an interrupted request arrived. This does not send a
            score.
          </p>
          {undelivered
            .filter((match) => match.sourceSetId)
            .map((match) => (
              <div className="ops-report" key={match.id}>
                <span>{match.label}</span>
                <Button
                  size="small"
                  type="submit"
                  disabled={disabled || pending !== null}
                  onClick={() => void reconcile(match)}
                >
                  Check interrupted delivery
                </Button>
              </div>
            ))}
        </Disclosure>
      )}
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
