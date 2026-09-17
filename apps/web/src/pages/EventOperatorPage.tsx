import { useParams } from '@tanstack/react-router';
import { EventOperationsPanel } from './admin/AdminEventOperationsPage';

/** Assigned organisers can operate an event without entering the admin shell. */
export function EventOperatorPage() {
  const { planId } = useParams({ from: '/operate/$planId' });
  return <EventOperationsPanel planId={planId} />;
}
