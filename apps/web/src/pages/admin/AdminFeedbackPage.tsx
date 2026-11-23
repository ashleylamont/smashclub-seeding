import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Button } from '../../components/ui/Button';
import { EmptyState, LoadingState, Notice } from '../../components/ui/Feedback';
import { githubIssueUrl } from '../../lib/feedback';
import { trpc } from '../../lib/trpc';
import './AdminFeedbackPage.css';

type InboxPage = Awaited<ReturnType<typeof trpc.admin.feedbackInbox.query>>;
type InboxCursor = NonNullable<InboxPage['nextCursor']>;

export function AdminFeedbackPage() {
  const [cursor, setCursor] = useState<InboxCursor>();
  const inbox = useQuery({
    queryKey: ['admin', 'feedbackInbox', cursor],
    queryFn: () => trpc.admin.feedbackInbox.query({ cursor }),
    gcTime: 0,
    retry: false,
  });

  return (
    <section className="admin-feedback-inbox" aria-labelledby="feedback-inbox-title">
      <header className="page-header">
        <h2 id="feedback-inbox-title">Past private feedback</h2>
        <p className="muted">
          Past private reports expire after 90 days. New reports go directly to GitHub.
        </p>
        <div className="ui-actions">
          <Button asChild>
            <Link to="/admin/review">Identity review queue</Link>
          </Button>
          <Button asChild>
            <a href={githubIssueUrl} target="_blank" rel="noopener noreferrer">
              Open public GitHub issue (new tab)
            </a>
          </Button>
        </div>
      </header>
      {inbox.isPending && <LoadingState>Loading feedback…</LoadingState>}
      {inbox.isError && (
        <Notice tone="danger">
          Feedback could not be loaded.
          <div>
            <Button onClick={() => void inbox.refetch()} pending={inbox.isFetching}>
              Try again
            </Button>
          </div>
        </Notice>
      )}
      {(cursor || inbox.data?.nextCursor) && (
        <nav className="ui-actions" aria-label="Feedback pages">
          <Button disabled={!cursor} onClick={() => setCursor(undefined)}>
            Newest reports
          </Button>
          <Button
            disabled={!inbox.data?.nextCursor}
            onClick={() => {
              if (inbox.data?.nextCursor) setCursor(inbox.data.nextCursor);
            }}
          >
            Older reports
          </Button>
        </nav>
      )}
      {inbox.data?.reports.length === 0 && <EmptyState title="No reports on this page" />}
      {inbox.data?.reports.map((report) => (
        <article key={report.reference} className="card admin-feedback-report">
          <h3>{report.summary}</h3>
          <p className="muted">
            <time dateTime={report.createdAt}>{new Date(report.createdAt).toLocaleString()}</time>
            {' · '}v{report.version} · build {report.build}
          </p>
          <p className="muted">
            Reference <code>{report.reference}</code>
          </p>
          <p className="admin-feedback-description">{report.description}</p>
        </article>
      ))}
    </section>
  );
}
