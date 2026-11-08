import { qualifierLabel } from '../lib/qualification';
import type { PublicEventSnapshot } from '../lib/usePlayerEventHub';

export function PendingFinals({
  fields,
  entrants,
}: {
  fields: NonNullable<PublicEventSnapshot['pendingFinals']>;
  entrants: PublicEventSnapshot['entrants'];
}) {
  const names = new Map(entrants.map(({ id, name }) => [id, name]));
  return (
    <section className="pending-finals">
      <h2>Finals qualification</h2>
      <p className="event-live-note">
        Places without a name are still awaiting qualification. Pairings appear when the organisers
        create the draw. Planned seeding combines pool place and frozen WHR rating.
      </p>
      <div className="pending-finals-grid">
        {fields.map(({ division, stage, slots }) => (
          <article className="card" key={`${division}:${stage}`}>
            <h3>
              {division === 'upper' ? 'Upper' : 'Lower'}{' '}
              {stage === 'main' ? 'Championship' : 'Consolation'}
            </h3>
            <ul className="pending-finals-sources">
              {slots.map((slot) => (
                <li key={`${slot.poolId}:${slot.place}`}>
                  <span>{qualifierLabel(slot)}</span>
                  {slot.status === 'review_pending' && <strong>Under score review</strong>}
                  {slot.status === 'resolved' && (
                    <strong>{(slot.entrantId && names.get(slot.entrantId)) || 'Confirmed'}</strong>
                  )}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}
