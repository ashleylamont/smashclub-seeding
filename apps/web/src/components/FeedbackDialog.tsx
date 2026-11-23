import { useId, useLayoutEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  FEEDBACK_DESCRIPTION_MAX,
  FEEDBACK_ISSUES_URL,
  FEEDBACK_SUMMARY_MAX,
} from '@smashclub/shared';
import {
  buildContext,
  githubFeedbackDraft,
  publicFeedbackAvailable,
  sendFeedback,
  type FeedbackFailure,
} from '../lib/feedback';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { Notice } from './ui/Feedback';
import { Field } from './ui/Field';
import { Textarea } from './ui/Input';
import './FeedbackDialog.css';

const failureCopy: Record<FeedbackFailure, string> = {
  busy: 'Issue posting is busy. Try again later.',
  unavailable: 'Posting from Nemesis is unavailable. You can submit a draft with a GitHub account.',
  rejected: 'GitHub did not accept the issue. Try again or open a draft on GitHub.',
  unknown:
    'Nemesis could not confirm whether GitHub posted the issue. Retrying uses the same report.',
  unresolved: 'Nemesis could not confirm this issue. Check GitHub before opening a new draft.',
  conflict: 'Nemesis could not confirm this request. Check the GitHub issues list for your report.',
};

export function FeedbackDialog() {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [missing, setMissing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<FeedbackFailure>();
  const [receipt, setReceipt] = useState<number>();
  const attempt = useRef<string | undefined>(undefined);
  const posting = useRef(false);
  const summaryField = useRef<HTMLInputElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const postButton = useRef<HTMLButtonElement>(null);
  const issueLink = useRef<HTMLAnchorElement>(null);
  const focusAfterRender = useRef<RefObject<HTMLElement | null> | null>(null);
  const descriptionId = useId();
  const draft = { summary: summary.trim(), description: description.trim() };
  const availability = useQuery({
    queryKey: ['feedback', 'public-availability'],
    queryFn: publicFeedbackAvailable,
    enabled: open,
    staleTime: 30_000,
    retry: false,
  });
  const canPost = availability.data === true;
  const unavailable = availability.isError || availability.data === false;
  const manualOnly = error === 'unresolved' || error === 'conflict';
  const uncertain = error === 'unknown' || manualOnly;
  const manualDraft = githubFeedbackDraft(reviewing ? draft : undefined);

  useLayoutEffect(() => {
    if (!open) return;
    const focusTarget = focusAfterRender.current;
    focusAfterRender.current = null;
    focusTarget?.current?.focus();
  }, [open, pending, receipt, reviewing]);

  function changeOpen(next: boolean) {
    if (!next) focusAfterRender.current = null;
    setOpen(next);
  }

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.summary || !draft.description) {
      setMissing(true);
      return;
    }
    setMissing(false);
    focusAfterRender.current = reviewHeading;
    setReviewing(true);
  }

  function edit() {
    attempt.current = undefined;
    setError(undefined);
    focusAfterRender.current = summaryField;
    setReviewing(false);
  }

  async function post() {
    if (posting.current || (!canPost && !uncertain) || manualOnly) return;
    posting.current = true;
    setPending(true);
    const focused = document.activeElement;
    const dialog = postButton.current?.closest('[role="dialog"]');
    try {
      if (typeof crypto.randomUUID !== 'function') {
        setError('unavailable');
        return;
      }
      attempt.current ??= crypto.randomUUID();
      const result = await sendFeedback(attempt.current, draft).catch(() => 'unknown' as const);
      const active = document.activeElement;
      const retainFocus =
        focused === postButton.current &&
        (active === focused || active === dialog || active === document.body);
      if (typeof result === 'number') {
        focusAfterRender.current = retainFocus ? issueLink : null;
        attempt.current = undefined;
        setReceipt(result);
        setSummary('');
        setDescription('');
        setError(undefined);
        return;
      }
      const failure = uncertain && result === 'busy' ? 'unknown' : result;
      if (failure === 'rejected') attempt.current = undefined;
      if (failure === 'unavailable') void availability.refetch();
      if (retainFocus)
        focusAfterRender.current =
          failure === 'conflict' || failure === 'unresolved' ? reviewHeading : postButton;
      setError(failure);
    } finally {
      posting.current = false;
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={changeOpen}
      title="Give feedback"
      description="Reports appear publicly on GitHub. No account required. Leave out personal details and guest links."
      trigger={
        <Button variant="plain" className="link-button">
          Give feedback
        </Button>
      }
    >
      {receipt ? (
        <div className="feedback-dialog-receipt">
          <Notice tone="success">Feedback posted publicly.</Notice>
          <div className="ui-actions">
            <Button asChild>
              <a
                ref={issueLink}
                href={`${FEEDBACK_ISSUES_URL}/${receipt}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                View issue #{receipt} (new tab)
              </a>
            </Button>
            <Button
              onClick={() => {
                setReceipt(undefined);
                edit();
              }}
            >
              Send another report
            </Button>
          </div>
        </div>
      ) : reviewing ? (
        <section className="feedback-dialog-preview" aria-labelledby={`${descriptionId}-preview`}>
          <h3 ref={reviewHeading} id={`${descriptionId}-preview`} tabIndex={-1}>
            Issue preview
          </h3>
          <div className="feedback-dialog-draft card">
            <p>
              <strong>{draft.summary}</strong>
            </p>
            <p className="feedback-dialog-draft-description">{draft.description}</p>
            <p className="muted">Nemesis {buildContext}</p>
          </div>
          {error && <Notice tone="danger">{failureCopy[error]}</Notice>}
          {availability.isPending && <Notice>Checking whether Nemesis can post to GitHub…</Notice>}
          {unavailable && !error && <Notice tone="warning">{failureCopy.unavailable}</Notice>}
          {!manualOnly && (
            <div className="ui-actions">
              {(!unavailable || uncertain) && (
                <Button
                  ref={postButton}
                  onClick={() => void post()}
                  variant="primary"
                  disabled={!canPost && !uncertain}
                  pending={pending}
                >
                  {pending
                    ? uncertain
                      ? 'Checking GitHub…'
                      : 'Posting issue…'
                    : uncertain
                      ? 'Retry report'
                      : 'Post public issue'}
                </Button>
              )}
              {!uncertain && (
                <Button onClick={edit} disabled={pending}>
                  Edit report
                </Button>
              )}
            </div>
          )}
        </section>
      ) : (
        <form className="feedback-dialog-form" onSubmit={review}>
          <Field
            ref={summaryField}
            label="Summary"
            required
            maxLength={FEEDBACK_SUMMARY_MAX}
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
          />
          <div className="ui-field">
            <label htmlFor={descriptionId}>Description</label>
            <Textarea
              id={descriptionId}
              required
              maxLength={FEEDBACK_DESCRIPTION_MAX}
              rows={4}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              aria-describedby={`${descriptionId}-hint`}
            />
            <span id={`${descriptionId}-hint`} className="ui-field-hint">
              What happened or what could improve?
            </span>
          </div>
          {missing && <Notice tone="danger">Enter a summary and description.</Notice>}
          {unavailable && <Notice tone="warning">{failureCopy.unavailable}</Notice>}
          <Button type="submit" variant="primary">
            Review issue
          </Button>
        </form>
      )}
      {!receipt && !pending && (
        <div className="feedback-dialog-fallback">
          {uncertain && (
            <Button asChild>
              <a href={FEEDBACK_ISSUES_URL} target="_blank" rel="noopener noreferrer">
                Check GitHub issues (new tab)
              </a>
            </Button>
          )}
          {(!uncertain || manualOnly) && (
            <>
              <Button asChild>
                <a href={manualDraft.href} target="_blank" rel="noopener noreferrer">
                  {manualDraft.includesDraft
                    ? 'Open reviewed draft on GitHub (new tab)'
                    : 'Open GitHub draft (new tab)'}
                </a>
              </Button>
              {reviewing && !manualDraft.includesDraft && (
                <p className="muted">Copy the report text into the GitHub draft.</p>
              )}
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}
