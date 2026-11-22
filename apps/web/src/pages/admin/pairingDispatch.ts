import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { Command, Overview } from './dispatchTypes';
import type { DispatchCommandController } from './dispatchCommand';
import { focusDispatchTarget } from './dispatchKeyboard';

export type StartPairing = Extract<Command, { kind: 'dispatch' }>;

type DispatchAttempt = {
  matchId: string;
  source: HTMLButtonElement;
  pending: boolean;
  removedWithFocus: boolean;
};

export function usePairingDispatch({
  planId,
  desk,
  dispatch,
  active,
  heading,
}: {
  planId: string;
  desk: Overview['operatorDispatch'];
  dispatch: DispatchCommandController;
  active: boolean;
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  const [starting, setStarting] = useState<{ matchId: string; action: 'ordinary' | 'named' }>();
  const [confirmation, setConfirmation] = useState<{ planId: string; text: string }>();
  const confirmationText = confirmation?.planId === planId ? confirmation.text : undefined;
  const attempt = useRef<DispatchAttempt | null>(null);
  const dispatchButtonRef = useCallback((source: HTMLButtonElement | null) => {
    if (!source) return;
    return () => {
      const current = attempt.current;
      // React detaches the ref before the browser drops focus on removal.
      if (current?.source === source) current.removedWithFocus = document.activeElement === source;
    };
  }, []);
  useLayoutEffect(() => {
    const current = attempt.current;
    if (!active) {
      attempt.current = null;
      return;
    }
    if (!current) return;
    if (current.removedWithFocus && !current.source.isConnected) {
      // A filter or queue reorder can remove the button before the call completes.
      const state = desk?.queue.find(({ matchId }) => matchId === current.matchId)?.state;
      current.removedWithFocus = state === 'called' || state === 'playing';
    }
    if (current.pending) return;
    // Only the commit that settles this command and its refresh owns the focus handoff.
    attempt.current = null;
    if (
      current.removedWithFocus &&
      !current.source.isConnected &&
      confirmationText &&
      document.activeElement === document.body
    ) {
      focusDispatchTarget(heading.current);
    }
  });
  const startPairing = (command: StartPairing, title: string, source: HTMLButtonElement) => {
    if (dispatch.busy || attempt.current?.pending) return;
    const current = { matchId: command.matchId, source, pending: true, removedWithFocus: false };
    attempt.current = current;
    setConfirmation(undefined);
    const stationId = command.stationId;
    setStarting({ matchId: command.matchId, action: stationId ? 'named' : 'ordinary' });
    const destination = stationId
      ? desk?.stations.find((station) => station.id === stationId)?.name
      : (command.callLocation ?? 'Any available ordinary setup');
    void dispatch.run(command).then((succeeded) => {
      current.pending = false;
      setStarting(undefined);
      if (succeeded) {
        const action = stationId ? 'Started' : 'Called';
        setConfirmation({
          planId,
          text: `${action} ${title}${destination ? ` · ${destination}` : ''}`,
        });
      } else if (attempt.current === current) {
        attempt.current = null;
      }
    });
  };
  return { starting, confirmationText, dispatchButtonRef, startPairing };
}
