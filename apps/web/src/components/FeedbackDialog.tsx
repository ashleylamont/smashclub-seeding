import { useId, useLayoutEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { FEEDBACK_DESCRIPTION_MAX, FEEDBACK_SUMMARY_MAX } from '@smashclub/shared';
import { APP_VERSION, BUILD_LABEL } from '../lib/build';
import { githubIssueUrl, sendFeedback } from '../lib/feedback';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { Notice } from './ui/Feedback';
import { Field } from './ui/Field';
import { Textarea } from './ui/Input';
import './FeedbackDialog.css';

const buildContext = `v${APP_VERSION} · build ${BUILD_LABEL}`;
const draftUrl = new URL(githubIssueUrl);
draftUrl.searchParams.set(
  'body',
  `<!-- Describe the bug or idea. For a bug, include what you expected and the steps to reproduce it. For an idea, explain what would improve. -->\n\nNemesis ${buildContext}`,
);

type DraftAttempt = { requestId: string; summary: string; description: string };

export function FeedbackDialog() {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [reference, setReference] = useState('');
  const attempt = useRef<DraftAttempt | null>(null);
  const summaryField = useRef<HTMLInputElement>(null);
  const submitButton = useRef<HTMLButtonElement>(null);
  const nextReport = useRef<HTMLButtonElement>(null);
  const submitFocus = useRef<{ control: HTMLElement; dialog: Element } | null>(null);
  const focusAfterRender = useRef<RefObject<HTMLElement | null> | null>(null);
  const descriptionId = useId();

  useLayoutEffect(() => {
    if (!open) return;
    const focusTarget = focusAfterRender.current;
    focusAfterRender.current = null;
    focusTarget?.current?.focus();
  }, [open, pending, reference]);

  function changeOpen(next: boolean) {
    if (!next) {
      submitFocus.current = null;
      focusAfterRender.current = null;
    }
    setOpen(next);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || reference) return;
    const text = { summary: summary.trim(), description: description.trim() };
    if (!text.summary || !text.description) {
      setError('Enter a summary and description.');
      return;
    }
    const focused = document.activeElement;
    const dialog = event.currentTarget.closest('[role="dialog"]');
    if (
      dialog &&
      focused instanceof HTMLElement &&
      event.currentTarget.contains(focused) &&
      focused.matches(':focus-visible')
    ) {
      submitFocus.current = { control: focused, dialog };
    }
    // Disabling the submit button can drop focus to the body or dialog. A new
    // focus target chosen while the request is pending should keep focus.
    const handleFocus = (event: FocusEvent) => {
      const origin = submitFocus.current;
      if (
        origin &&
        event.target !== origin.control &&
        event.target !== origin.dialog &&
        event.target !== document.body
      ) {
        submitFocus.current = null;
      }
    };
    document.addEventListener('focusin', handleFocus);
    setPending(true);
    setError('');
    let sent = false;
    try {
      if (
        attempt.current?.summary !== text.summary ||
        attempt.current.description !== text.description
      ) {
        attempt.current = { requestId: crypto.randomUUID(), ...text };
      }
      const requestId = attempt.current.requestId;
      const result = await sendFeedback(requestId, text.summary, text.description);
      if (typeof result === 'object') {
        sent = true;
        setReference(result.reference);
        setSummary('');
        setDescription('');
        attempt.current = null;
      } else if (result === 'busy') {
        setError('The feedback inbox is busy. Try again later.');
      } else {
        if (result === 'conflict') attempt.current = null;
        setError('Feedback could not be sent. Try again.');
      }
    } catch {
      setError('Feedback could not be sent. Try again.');
    } finally {
      document.removeEventListener('focusin', handleFocus);
      const origin = submitFocus.current;
      const active = document.activeElement;
      if (
        origin &&
        (active === origin.dialog ||
          active === document.body ||
          (sent && active === origin.control))
      ) {
        focusAfterRender.current = sent ? nextReport : submitButton;
      }
      submitFocus.current = null;
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={changeOpen}
      title="Give feedback"
      description="Send a private report to the Nemesis maintainers. No account required. Leave out personal details and guest links."
      trigger={
        <Button variant="plain" className="link-button">
          Give feedback
        </Button>
      }
    >
      {reference ? (
        <div className="feedback-dialog-receipt">
          <Notice tone="success">
            Feedback sent. Reference <code>{reference}</code>
          </Notice>
          <Button
            ref={nextReport}
            onClick={() => {
              focusAfterRender.current = summaryField;
              setReference('');
            }}
          >
            Send another report
          </Button>
        </div>
      ) : (
        <form className="feedback-dialog-form" onSubmit={submit}>
          <Field
            ref={summaryField}
            label="Summary"
            required
            maxLength={FEEDBACK_SUMMARY_MAX}
            value={summary}
            readOnly={pending}
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
              readOnly={pending}
              aria-describedby={`${descriptionId}-hint`}
              onChange={(event) => setDescription(event.target.value)}
            />
            <span id={`${descriptionId}-hint`} className="ui-field-hint">
              What happened or what could improve?
            </span>
          </div>
          <p className="muted">Includes {buildContext}.</p>
          {error && <Notice tone="danger">{error}</Notice>}
          <Button ref={submitButton} type="submit" variant="primary" pending={pending}>
            {pending ? 'Sending feedback…' : 'Send private feedback'}
          </Button>
        </form>
      )}
      <div className="feedback-dialog-fallback">
        <p className="muted">Public issues require a GitHub account.</p>
        <Button asChild>
          <a href={draftUrl.href} target="_blank" rel="noopener noreferrer">
            Open GitHub draft (new tab)
          </a>
        </Button>
      </div>
    </Dialog>
  );
}
