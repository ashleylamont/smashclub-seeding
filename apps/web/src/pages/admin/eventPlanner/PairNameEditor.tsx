import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button } from '../../../components/ui/Button';
import { Dialog } from '../../../components/ui/Dialog';
import { Field } from '../../../components/ui/Field';
import { Notice } from '../../../components/ui/Feedback';
import type { EventPlanView } from '../../../lib/apiTypes';
import { trpc } from '../../../lib/trpc';

type Pair = EventPlanView['entries'][number];

export function PairNameEditor({
  planId,
  pair,
  onChanged,
}: {
  planId: string;
  pair: Pair;
  onChanged: () => void | Promise<unknown>;
}) {
  const [draft, setDraft] = useState<{
    name: string;
    revision: string;
    requestId: string;
    members: string;
  } | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const members = pair.memberNames?.join(' / ') || pair.playerName || 'Doubles pair';
  const save = useMutation({
    mutationFn: (intent: NonNullable<typeof draft>) =>
      trpc.admin.eventPlanner.renameDoublesPair.mutate({
        planId,
        entrantId: pair.id,
        teamName: intent.name.trim() || null,
        expectedRevision: intent.revision,
        requestId: intent.requestId,
      }),
    onSuccess: async () => {
      await onChanged();
      setDraft(null);
    },
    onError: () => void onChanged(),
  });
  if (!draft && !pair.pairNameRevision) return null;

  const changed = draft && draft.revision !== pair.pairNameRevision;
  const canSave = draft && !changed && (draft.name.trim() || null) !== (pair.teamName || null);
  return (
    <Dialog
      title="Rename pair"
      description="Change the optional public team name. Players, seeds and match results stay the same."
      open={Boolean(draft)}
      onOpenChange={(open) => {
        if (save.isPending) return;
        save.reset();
        setDraft(
          open && pair.pairNameRevision
            ? {
                name: pair.teamName ?? '',
                revision: pair.pairNameRevision,
                requestId: crypto.randomUUID(),
                members,
              }
            : null,
        );
      }}
      trigger={
        <Button size="small" aria-label={`Rename pair ${members}`}>
          Rename
        </Button>
      }
    >
      {draft && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (canSave && !save.isPending) save.mutate(draft);
          }}
        >
          <p>{draft.members}</p>
          <Field
            ref={field}
            label="Team name"
            hint="Leave blank to use the two player names."
            value={draft.name}
            maxLength={60}
            disabled={save.isPending}
            onChange={(event) =>
              setDraft({ ...draft, name: event.target.value, requestId: crypto.randomUUID() })
            }
          />
          {changed ? (
            <Notice tone="danger">
              {pair.pairNameRevision ? (
                <>
                  The pair changed. {draft.members !== members && <>Current players: {members}. </>}
                  {pair.teamName
                    ? `Current name: ${pair.teamName}.`
                    : 'There is no current team name.'}
                </>
              ) : (
                'The pair can no longer be renamed.'
              )}
            </Notice>
          ) : save.error ? (
            <Notice tone="danger">{save.error.message}</Notice>
          ) : null}
          <div className="modal-actions">
            <Button disabled={save.isPending} onClick={() => setDraft(null)}>
              Cancel
            </Button>
            {changed ? (
              pair.pairNameRevision && (
                <Button
                  variant="primary"
                  disabled={save.isPending}
                  onClick={(event) => {
                    // This action becomes the submit button after accepting fresh details.
                    event.preventDefault();
                    save.reset();
                    setDraft({
                      ...draft,
                      revision: pair.pairNameRevision!,
                      requestId: crypto.randomUUID(),
                      members,
                    });
                    field.current?.focus();
                  }}
                >
                  Use current pair details
                </Button>
              )
            ) : (
              <Button type="submit" variant="primary" pending={save.isPending} disabled={!canSave}>
                {save.isPending ? 'Saving…' : 'Save team name'}
              </Button>
            )}
          </div>
        </form>
      )}
    </Dialog>
  );
}
