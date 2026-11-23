import type { BroadcastPresentationMode } from '@smashclub/shared';
import { useMutation } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { useState } from 'react';
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
  });
  if (!current) return null;

  const { mode, revision } = current;
  const open = data.plan.status === 'underway';
  const published = data.settings.published;
  const selection = draft?.revision === revision ? draft.mode : mode;
  const canSave = open && published && !disabled && !save.isPending;
  const stale = draft && draft.revision !== revision;
  return (
    <section className="card ops-broadcast-presentation" aria-label="Event-following presentation">
      <h3>Event-following presentation</h3>
      <p className="muted">Changes apply to Follow event overlay sources on their next refresh.</p>
      {open ? (
        <>
          {!published && <p>Publish the event to switch its presentation.</p>}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (canSave && selection !== mode)
                save.mutate({ planId: data.plan.id, expectedRevision: revision, mode: selection });
            }}
          >
            <label className="ui-field">
              Event presentation
              <Select
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
                type="submit"
                pending={save.isPending}
                disabled={!canSave || selection === mode}
              >
                {save.isPending ? 'Applying…' : 'Apply presentation'}
              </Button>
            </div>
          </form>
          {save.error && <Notice tone="danger">{save.error.message}</Notice>}
          {stale && (
            <Notice tone="warning">The current presentation changed. Choose a mode again.</Notice>
          )}
          {save.data?.revision === revision && (
            <Notice tone="success">Event presentation set to {labels[mode]}.</Notice>
          )}
        </>
      ) : (
        <p className="muted">Presentation can be switched while the event is underway.</p>
      )}
    </section>
  );
}
