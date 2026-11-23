import { useCallback, useRef, type ComponentType, type ReactNode, type RefCallback } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Button } from '../components/ui/Button';
import { LoadingState, Notice } from '../components/ui/Feedback';
import { PageHeader } from '../components/ui/PageHeader';
import { eventUnavailable } from '../lib/eventErrors';

const labels = {
  tournaments: { title: 'Tournaments', unavailable: 'Tournaments unavailable' },
  event: { title: 'Event results', unavailable: 'Event not found' },
  tournament: { title: 'Tournament results', unavailable: 'Tournament not found' },
};

export type ArchivePageFeedback = {
  headingRef: RefCallback<HTMLHeadingElement>;
  refreshNotice: ReactNode;
};

export function ArchiveQueryContent<T>({
  kind,
  query,
  content: Content,
}: {
  kind: keyof typeof labels;
  query: UseQueryResult<T | null>;
  content: ComponentType<{ data: T } & ArchivePageFeedback>;
}) {
  const restoreFocus = useRef(false);
  const rememberRetryFocus = useCallback((button: HTMLButtonElement | null) => {
    if (!button) return;
    return () => {
      restoreFocus.current = document.activeElement === button;
    };
  }, []);

  // Consume this after the retry button unmounts. An existing heading can also
  // receive focus when a refresh kept the rest of the page mounted.
  function focusAfterRetry(element: HTMLElement | null) {
    if (!element || !restoreFocus.current) return;
    restoreFocus.current = false;
    element.focus();
  }

  const { title, unavailable } = labels[kind];
  // Publication and permission failures replace any previously loaded content.
  if (eventUnavailable(query.error) || (query.isSuccess && query.data === null)) {
    if (kind === 'tournaments')
      return (
        <h1 ref={focusAfterRetry} tabIndex={-1}>
          {unavailable}
        </h1>
      );

    return (
      <PageHeader
        title={unavailable}
        actions={
          <Button asChild>
            <Link ref={focusAfterRetry} to="/tournaments">
              Browse tournaments
            </Link>
          </Button>
        }
      />
    );
  }

  // TanStack Query clears an uncached error while fetching again. Keep the
  // focused retry button and its live region mounted until the result arrives.
  const hasError = query.isError || (query.isPending && query.errorUpdateCount > 0);
  const busy = query.isFetching || query.isPaused;
  const subject = kind === 'tournaments' ? kind : `this ${kind}`;
  const errorMessage =
    query.data == null
      ? `Could not load ${subject}.`
      : `Could not refresh ${subject}. This page may be out of date.`;
  const pendingMessage = query.isPaused ? 'Waiting for a connection…' : 'Trying again…';
  const retry = hasError && (
    <>
      <Notice tone={busy ? 'info' : 'danger'} live={false}>
        {!busy && <span role="alert">{errorMessage}</span>}
        <div className={busy ? undefined : 'visually-hidden'}>
          <LoadingState>{busy ? pendingMessage : ''}</LoadingState>
        </div>
      </Notice>
      <Button
        ref={rememberRetryFocus}
        aria-disabled={busy || undefined}
        onClick={() => {
          if (!busy) void query.refetch({ cancelRefetch: false });
        }}
      >
        Try again
      </Button>
    </>
  );

  if (query.data != null) {
    return <Content data={query.data} headingRef={focusAfterRetry} refreshNotice={retry} />;
  }

  return (
    <>
      <PageHeader title={title} />
      {retry || <LoadingState>{query.isPaused ? pendingMessage : `Loading ${kind}…`}</LoadingState>}
    </>
  );
}
