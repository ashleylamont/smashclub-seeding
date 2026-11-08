import {
  finalsFieldLabel,
  plannedFinalsSeeding,
  qualifierDetail,
  qualifierLabel,
  type PublicFinalsField,
} from '../lib/qualification';

export function PendingFinals({
  fields,
  entrants,
}: {
  fields: PublicFinalsField[];
  entrants: { id: string; name: string }[];
}) {
  const names = new Map(entrants.map(({ id, name }) => [id, name]));
  return (
    <section className="pending-finals">
      <h2>Finals qualification</h2>
      <p className="event-live-note">
        Places without a name are still awaiting qualification. Pairings appear when the organisers
        create the draw. {plannedFinalsSeeding}
      </p>
      <div className="pending-finals-grid">
        {fields.map(({ division, stage, slots }) => (
          <article className="card" key={`${division}:${stage}`}>
            <h3>{finalsFieldLabel({ division, stage })}</h3>
            <ul className="pending-finals-sources">
              {slots.map((slot) => {
                const detail = qualifierDetail(slot, names);
                return (
                  <li key={`${slot.poolId}:${slot.place}`}>
                    <span>{qualifierLabel(slot)}</span>
                    {detail && <strong>{detail}</strong>}
                  </li>
                );
              })}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}
