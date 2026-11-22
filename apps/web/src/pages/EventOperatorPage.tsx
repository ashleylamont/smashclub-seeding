import { Link, useParams, useSearch } from '@tanstack/react-router';
import { Button } from '../components/ui/Button';
import { LoadingState } from '../components/ui/Feedback';
import { PageHeader } from '../components/ui/PageHeader';
import { authClient } from '../lib/auth';
import { operatorDestination } from '../lib/operatorDestination';
import { EventOperationsPanel } from './admin/AdminEventOperationsPage';
import './Auth.css';

/** Assigned organisers can operate an event without entering the admin shell. */
export function EventOperatorPage() {
  const { planId } = useParams({ from: '/operate/$planId' });
  const { view, station } = useSearch({ from: '/operate/$planId' });
  const destination = operatorDestination({ operate: planId, view, station });
  const { data: session, isPending, error, refetch } = authClient.useSession();

  if (!destination)
    return <PageHeader title="Event unavailable" description="Check the event control link." />;
  if (isPending) return <LoadingState>Checking sign-in…</LoadingState>;
  if (session) return <EventOperationsPanel key={session.user.id} planId={destination.operate} />;
  if (error && error.status !== 401)
    return (
      <PageHeader
        title="Could not check sign-in"
        description="Check your connection and try again."
        actions={<Button onClick={() => void refetch()}>Try again</Button>}
      />
    );

  return (
    <div className="login-wrap">
      <section className="login-card card">
        <h1>Event control</h1>
        <p className="muted">Sign in with the account assigned to this event.</p>
        <Button asChild variant="primary">
          <Link to="/login" search={destination}>
            Sign in to event control
          </Link>
        </Button>
      </section>
    </div>
  );
}
