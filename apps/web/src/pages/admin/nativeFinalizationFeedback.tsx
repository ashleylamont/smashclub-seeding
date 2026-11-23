import { useLayoutEffect, useRef, type RefObject } from 'react';
import { Notice } from '../../components/ui/Feedback';

export type NativeBracketFeedback = {
  action: 'finalize' | 'draw';
  tone: 'success' | 'danger';
  message: string;
};

export function useFinalizationFocus(busy: boolean, ended: boolean, failed: boolean) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);
  useLayoutEffect(() => {
    if (busy || !restoreFocus.current) return;
    const frame = requestAnimationFrame(() => {
      // A successful mutation and the closed overview can reach the desk in separate renders.
      if (ended || failed) restoreFocus.current = false;
      if (document.activeElement === document.body)
        (ended ? feedbackRef.current : buttonRef.current)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [busy, ended, failed]);
  return {
    buttonRef,
    feedbackRef,
    restoreAfterFinalization: () => {
      restoreFocus.current = true;
    },
  };
}

export function closedFinalizationFeedback(
  heading: string,
  feedbackRef: RefObject<HTMLDivElement | null>,
  feedback: NativeBracketFeedback | null,
) {
  if (feedback?.action !== 'finalize' || !feedback.message) return null;
  return (
    <section className="card native-finals-controls">
      <h3>{heading}</h3>
      <div ref={feedbackRef} tabIndex={-1} role="group" aria-label="Finalization feedback">
        <Notice tone={feedback.tone}>{feedback.message}</Notice>
      </div>
    </section>
  );
}
