import type { BroadcastPresentationMode } from '@smashclub/shared';
import { useMutation } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Notice } from '../../components/ui/Feedback';
import { Select, SelectItem } from '../../components/ui/Select';
import { trpc } from '../../lib/trpc';
import type { Overview } from './dispatchTypes';
import { OpsTwitchPromotion } from './OpsTwitchPromotion';

type PresentationRequest = Parameters<typeof trpc.eventOps.setBroadcastPresentation.mutate>[0];

const labels: Record<BroadcastPresentationMode, string> = {
  auto: 'Automatic',
  gameplay: 'Gameplay',
  progress: 'Progress',
};

export function OpsBroadcastSettings({
  data,
  disabled,
  act,
  refresh,
}: {
  data: Overview;
  disabled: boolean;
  act: (work: () => Promise<unknown>, message?: string) => Promise<void>;
  refresh: () => Promise<unknown>;
}) {
  return (
    <>
      <OpsBroadcastPresentation
        key={data.plan.id}
        data={data}
        disabled={disabled}
        refresh={refresh}
      />
      <OpsTwitchPromotion data={data} disabled={disabled} act={act} refresh={refresh} />
    </>
  );
}

function OpsBroadcastPresentation({
  data,
  disabled,
  refresh,
}: {
  data: Overview;
  disabled: boolean;
  refresh: () => Promise<unknown>;
}) {
  const current = data.broadcastPresentation;
  const form = useRef<HTMLFormElement>(null);
  const applyButton = useRef<HTMLButtonElement>(null);
  const picker = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);
  const [draft, setDraft] = useState<{ mode: BroadcastPresentationMode; revision: number }>();
  const save = useMutation({
    mutationFn: (request: PresentationRequest) =>
      trpc.eventOps.setBroadcastPresentation.mutate(request),
    onSuccess: async () => {
      setDraft(undefined);
      await refresh();
    },
    onError: async (cause) => {
      if (cause instanceof TRPCClientError && cause.data?.code === 'CONFLICT') {
        setDraft(undefined);
        await refresh();
      }
    },
    onSettled: () => {
      inFlight.current = false;
    },
  });
  const open = data.plan.status === 'underway';
  const published = data.settings.published;
  const canSave = open && published && !disabled && !save.isPending;
  useLayoutEffect(() => {
    if (!canSave || document.activeElement !== form.current) return;
    const button = applyButton.current;
    const target = save.isError && button && !button.disabled ? button : picker.current;
    target?.focus({ preventScroll: true });
  }, [canSave, save.isError]);
  if (!current) return null;

  const { mode, revision } = current;
  const selection = draft?.revision === revision ? draft.mode : mode;
  const saved = save.data?.revision === revision;
  const feedback = saved
    ? `Event presentation set to ${labels[mode]}.`
    : draft && draft.revision !== revision
      ? 'The current presentation changed. Choose a mode again.'
      : '';
  return (
    <section className="card ops-broadcast-presentation" aria-label="Event-following presentation">
      <h3>Event-following presentation</h3>
      <p className="muted">Changes apply to Follow event overlay sources on their next refresh.</p>
      {open ? (
        <>
          {!published && <p>Publish the event to switch its presentation.</p>}
          <form
            ref={form}
            tabIndex={-1}
            aria-label="Change event presentation"
            aria-busy={save.isPending || undefined}
            onSubmit={(event) => {
              event.preventDefault();
              if (!canSave || selection === mode || inFlight.current) return;
              inFlight.current = true;
              // Hold focus within the form while its controls are disabled.
              if (document.activeElement === applyButton.current)
                event.currentTarget.focus({ preventScroll: true });
              save.mutate({ planId: data.plan.id, expectedRevision: revision, mode: selection });
            }}
          >
            <label className="ui-field">
              Event presentation
              <Select
                ref={picker}
                value={selection}
                disabled={!canSave}
                onValueChange={(mode) => {
                  save.reset();
                  setDraft({ mode: mode as BroadcastPresentationMode, revision });
                }}
              >
                <SelectItem value="auto">Automatic</SelectItem>
                <SelectItem value="gameplay">Gameplay</SelectItem>
                <SelectItem value="progress">Progress</SelectItem>
              </Select>
            </label>
            {selection !== mode && <p>Current presentation · {labels[mode]}</p>}
            <div className="ui-actions">
              <Button
                ref={applyButton}
                type="submit"
                pending={save.isPending}
                disabled={!canSave || selection === mode}
              >
                {save.isPending ? 'Applying…' : 'Apply presentation'}
              </Button>
            </div>
          </form>
          {save.error && <Notice tone="danger">{save.error.message}</Notice>}
          <div role="status" className={feedback ? undefined : 'visually-hidden'}>
            {feedback && (
              <Notice tone={saved ? 'success' : 'warning'} live={false}>
                {feedback}
              </Notice>
            )}
          </div>
        </>
      ) : (
        <p className="muted">Presentation can be switched while the event is underway.</p>
      )}
    </section>
  );
}
