import { twitchChannel } from '@smashclub/shared';
import { TRPCClientError } from '@trpc/client';
import { useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { trpc } from '../../lib/trpc';
import { useNow } from '../../lib/useNow';
import type { Overview } from './dispatchTypes';

type PromotionRequest = Parameters<typeof trpc.eventOps.setTwitchPromotion.mutate>[0];

export function OpsTwitchPromotion({
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
  const [draft, setDraft] = useState('');
  const attempted = useRef<PromotionRequest>(null);
  const now = useNow();
  const broadcast = data.twitchBroadcast;
  if (!broadcast) return null;
  const { promotion, revision } = broadcast;
  const channel = twitchChannel(draft);
  const published = data.settings.published;
  const open = data.plan.status === 'underway';
  const active = promotion && Date.parse(promotion.expiresAt) > now;

  const save = (request: PromotionRequest) => {
    attempted.current = request;
    void act(
      async () => {
        try {
          await trpc.eventOps.setTwitchPromotion.mutate(request);
          attempted.current = null;
          setDraft('');
        } catch (error) {
          if (
            error instanceof TRPCClientError &&
            [
              'BAD_REQUEST',
              'CONFLICT',
              'FORBIDDEN',
              'NOT_FOUND',
              'PRECONDITION_FAILED',
              'UNAUTHORIZED',
            ].includes(error.data?.code ?? '')
          ) {
            attempted.current = null;
            if (error.data.code === 'CONFLICT') await refresh();
          }
          throw error;
        }
      },
      request.promotion ? 'Twitch stream announced' : 'Twitch announcement stopped',
    );
  };

  return (
    <section className="card ops-twitch-promotion" aria-label="Public Twitch stream">
      <h3>Public Twitch stream</h3>
      {active && open && (
        <p>
          <strong>{promotion.channel}</strong> ·{' '}
          {published ? 'Shown to viewers' : 'Hidden while unpublished'} · expires{' '}
          <time dateTime={promotion.expiresAt}>
            {new Date(promotion.expiresAt).toLocaleString(undefined, {
              dateStyle: 'medium',
              timeStyle: 'short',
            })}
          </time>
        </p>
      )}
      {open ? (
        <>
          <p className="muted">
            Announce a channel for four hours. Unpublishing hides the stream. Republishing shows it
            again until it expires or you stop it.
          </p>
          {!published && <p>Publish the event before announcing a Twitch stream.</p>}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (disabled || !published || !channel) return;
              const previous = attempted.current;
              save(
                previous?.promotion?.channel === channel && previous.expectedRevision === revision
                  ? previous
                  : {
                      planId: data.plan.id,
                      expectedRevision: revision,
                      promotion: {
                        channel,
                        expiresAt: new Date(Date.now() + 4 * 60 * 60_000).toISOString(),
                      },
                    },
              );
            }}
          >
            <Field
              label="Twitch channel name or link"
              value={draft}
              onChange={(event) => {
                attempted.current = null;
                setDraft(event.target.value);
              }}
              autoComplete="off"
              spellCheck={false}
              maxLength={200}
              disabled={disabled || !published}
            />
            <div className="ui-actions">
              <Button type="submit" disabled={disabled || !published || !channel}>
                {active ? 'Update Twitch announcement' : 'Announce Twitch stream'}
              </Button>
              {active && (
                <Button
                  disabled={disabled}
                  onClick={() =>
                    save({ planId: data.plan.id, expectedRevision: revision, promotion: null })
                  }
                >
                  Stop Twitch announcement
                </Button>
              )}
            </div>
          </form>
        </>
      ) : (
        <p className="muted">Twitch announcements are available while the event is underway.</p>
      )}
    </section>
  );
}
