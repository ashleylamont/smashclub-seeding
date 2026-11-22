import { useId, useRef, useState, type FormEvent } from 'react';
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
  const descriptionId = useId();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || reference) return;
    const text = { summary: summary.trim(), description: description.trim() };
    if (!text.summary || !text.description) {
      setError('Enter a summary and description.');
      return;
    }
    setPending(true);
    setError('');
    try {
      if (
        attempt.current?.summary !== text.summary ||
        attempt.current.description !== text.description
      ) {
        attempt.current = { requestId: crypto.randomUUID(), ...text };
      }
      const requestId = attempt.current.requestId;
      const result = await sendFeedback(requestId, text.summary, text.description);
      if (result === 'sent') {
        setReference(requestId);
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
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
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
          <Button onClick={() => setReference('')}>Send another report</Button>
        </div>
      ) : (
        <form className="feedback-dialog-form" onSubmit={submit}>
          <Field
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
          <Button type="submit" variant="primary" pending={pending}>
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
