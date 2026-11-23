import { useMatch, useRouter, type ErrorComponentProps } from '@tanstack/react-router';
import { TRPCClientError } from '@trpc/client';
import { useRef, useState } from 'react';
import { Button } from '../components/ui/Button';
import { Notice } from '../components/ui/Feedback';
import { PageHeader } from '../components/ui/PageHeader';
import { eventUnavailable } from '../lib/eventErrors';

export function EventShortLinkError({ error }: ErrorComponentProps) {
  const router = useRouter();
  const matchId = useMatch({ strict: false, select: (match) => match.id });
  const pending = useRef(false);
  const [retrying, setRetrying] = useState(false);
  const unavailable =
    eventUnavailable(error) ||
    (error instanceof TRPCClientError && error.data?.code === 'BAD_REQUEST');

  async function retry() {
    if (pending.current) return;
    pending.current = true;
    setRetrying(true);
    try {
      await router.invalidate({ filter: (match) => match.id === matchId });
    } finally {
      pending.current = false;
      setRetrying(false);
    }
  }

  return (
    <>
      <PageHeader title="Open event" />
      {!retrying && (
        <Notice tone="danger">
          {unavailable
            ? 'This event is unavailable or has not been published.'
            : 'Could not open the event link.'}
        </Notice>
      )}
      {!unavailable && (
        <div className="ui-actions">
          <Button aria-disabled={retrying || undefined} onClick={() => void retry()}>
            Try again
          </Button>
          <span role="status">{retrying ? 'Opening event…' : ''}</span>
        </div>
      )}
    </>
  );
}
