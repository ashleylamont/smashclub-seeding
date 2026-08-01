import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import './InfoTip.css';

/**
 * A short explanation attached to a figure or a label.
 *
 * The app leans hard on `title=` to explain what its numbers mean — what the
 * ranked rating subtracts, what a movement arrow compares against, what a
 * confidence meter is full of. `title` is a hover affordance: on a phone it
 * never appears, which is precisely where the columns that carried those
 * explanations are dropped for space. So anything a reader genuinely needs in
 * order to trust a number gets one of these instead: a real button, opened by
 * tap or by keyboard, closed by Escape or by touching anything else.
 *
 * It is deliberately small. A page that needs a paragraph gets a paragraph;
 * this is for the one sentence that turns a mysterious figure into a legible
 * one.
 */

interface Props {
  /**
   * The thing being explained, as a short noun phrase. It names the button for
   * assistive tech *and* heads the panel — on a narrow screen the panel opens
   * as a bar at the bottom of the viewport, a long way from the mark that
   * opened it, so it has to say what it is answering.
   */
  label: string;
  children: ReactNode;
  /** Which edge the panel hangs from — `end` keeps it on screen at the right. */
  align?: 'start' | 'end';
}

export function InfoTip({ label, children, align = 'start' }: Props) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    // `pointerdown` rather than `click`, so a tap that lands on another control
    // dismisses this panel and still activates that control.
    const onPointerDown = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  return (
    <span className="info-tip" ref={wrap}>
      <button
        type="button"
        className={`info-tip-button${open ? ' is-open' : ''}`}
        aria-label={`Explain: ${label}`}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((was) => !was)}
      >
        <span aria-hidden="true">?</span>
      </button>
      {open && (
        <span className={`info-tip-panel info-tip-${align}`} id={panelId} role="note">
          <span className="info-tip-title">{label}</span>
          {children}
        </span>
      )}
    </span>
  );
}
