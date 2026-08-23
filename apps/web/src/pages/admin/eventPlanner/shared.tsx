import { useState, type ReactNode } from 'react';
import type { EventPlanIssue } from '../../../lib/apiTypes';

/**
 * Bits every step of the planner needs. The theme running through them is that
 * the venue may have no connectivity and the admin may be standing up: nothing
 * here is allowed to be the *only* way to get at something.
 */

/**
 * A copyable payload. The button is the fast path; the textarea below it is the
 * one that always works — `navigator.clipboard` is unavailable over plain HTTP
 * and can be refused outright, and "copy silently did nothing" is not a failure
 * mode to discover while sixteen people wait.
 */
export function CopyBlock({
  label,
  text,
  rows = 6,
  hint,
}: {
  label: string;
  text: string;
  rows?: number;
  hint?: ReactNode;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
      setTimeout(() => setState('idle'), 1500);
    } catch {
      setState('failed');
    }
  };

  return (
    <div className="copy-block">
      <div className="copy-block-header">
        <span className="form-label">{label}</span>
        <button type="button" className="btn btn-small" onClick={() => void copy()} disabled={text === ''}>
          {state === 'copied' ? 'Copied ✓' : 'Copy'}
        </button>
      </div>
      {state === 'failed' && (
        <p className="error-text">Clipboard unavailable — select the text below and copy it by hand.</p>
      )}
      {hint && <p className="form-hint">{hint}</p>}
      <textarea className="input copy-block-text" readOnly rows={rows} value={text} spellCheck={false} />
    </div>
  );
}

/** Blocking problems and warnings, each linking to the rows it is about. */
export function IssueList({
  issues,
  kind,
  onFocusRows,
}: {
  issues: EventPlanIssue[];
  kind: 'blocking' | 'warning';
  onFocusRows?: (entryIds: string[]) => void;
}) {
  if (issues.length === 0) return null;
  return (
    <div className={`banner ${kind === 'blocking' ? 'banner-danger' : 'banner-warning'}`}>
      <strong>{kind === 'blocking' ? 'Fix before freezing' : 'Worth a look'}</strong>
      <ul className="planner-issues">
        {issues.map((issue) => (
          <li key={issue.code + (issue.entryIds?.join(',') ?? '')}>
            {issue.message}
            {issue.entryIds && issue.entryIds.length > 0 && onFocusRows && (
              <button
                type="button"
                className="btn btn-small planner-issue-link"
                onClick={() => onFocusRows(issue.entryIds!)}
              >
                Show {issue.entryIds.length} row{issue.entryIds.length === 1 ? '' : 's'}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
