import { Checkbox } from '../../components/ui/Checkbox';
import { Input } from '../../components/ui/Input';
import { Button } from '../../components/ui/Button';
import { useState } from 'react';
import { trpc } from '../../lib/trpc';
type Overview = Awaited<ReturnType<typeof trpc.eventOps.overview.query>>;
export function OpsAccessControls({
  data,
  pending,
  closed,
  act,
}: {
  data: Overview;
  pending: boolean;
  closed: boolean;
  act: (work: () => Promise<unknown>, message?: string) => Promise<void>;
}) {
  const planId = data.plan.id;
  const [toUserId, setToUserId] = useState('');
  return (
    <section className="card">
      <h3>Event access</h3>
      <label className="ops-check">
        <Checkbox
          checked={data.settings.published}
          disabled={pending || closed}
          onCheckedChange={(nextChecked) =>
            void act(() =>
              trpc.eventOps.settings.mutate({
                planId,
                published: nextChecked,
                playerReports: data.settings.playerReports,
              }),
            )
          }
        />{' '}
        Publish live event page
      </label>
      <label className="ops-check">
        <Checkbox
          checked={data.settings.playerReports}
          disabled={pending || closed}
          onCheckedChange={(nextChecked) =>
            void act(() =>
              trpc.eventOps.settings.mutate({
                planId,
                published: data.settings.published,
                playerReports: nextChecked,
              }),
            )
          }
        />{' '}
        Allow signed-in attendees to report any match
      </label>
      <p className="muted">
        TOs use <a href={`/operate/${planId}`}>this event’s control link</a>. Grant access to an
        existing signed-in account.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            await trpc.eventOps.assignTo.mutate({ planId, email: toUserId });
            setToUserId('');
          });
        }}
      >
        <label>
          TO email address
          <Input
            type="email"
            value={toUserId}
            onChange={(e) => setToUserId(e.target.value)}
            required
          />
        </label>
        <Button type="submit" disabled={pending || closed}>
          Grant event access
        </Button>
      </form>
      <ul>
        {data.tos.map((to) => (
          <li key={to.id}>
            {to.name} ({to.email}){' '}
            <Button
              size="small"
              type="submit"
              disabled={pending || closed}
              onClick={() =>
                void act(() =>
                  trpc.eventOps.assignTo.mutate({ planId, userId: to.userId, remove: true }),
                )
              }
            >
              Remove access
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
