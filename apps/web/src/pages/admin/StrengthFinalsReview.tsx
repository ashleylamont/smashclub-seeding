import { Disclosure } from '../../components/ui/Disclosure';
import type { trpc } from '../../lib/trpc';

type Preview = Awaited<ReturnType<typeof trpc.eventOps.native.preview.query>>;
type Combined = Extract<Preview, { seedPolicy: 'pool_place_whr_v1' }>;
type Seeding = NonNullable<Combined['brackets'][number]['strengthSeeding']>;

function meetingCounts(rounds: number[]) {
  return rounds.some(Boolean)
    ? rounds.map((count, i) => `R${i + 1}: ${count}`).join(' · ')
    : 'None';
}

export function StrengthFinalsReview({
  seeding,
  name,
}: {
  seeding: Seeding;
  name: (id: string) => string;
}) {
  const byeNames = (ids: string[]) => ids.map(name).join(', ') || 'None';
  return (
    <Disclosure title="Compare seeding and byes">
      <p>
        The combined score subtracts {seeding.poolPlaceCost} points per place below first from
        conservative WHR (skill minus twice its uncertainty). The rating is frozen before play.
        Entrants without a frozen rating use the event’s conservative prior.
      </p>
      <p className="muted">Scroll sideways to compare every seed column.</p>
      <div
        className="table-scroll"
        role="region"
        aria-label="Finals seeding comparison"
        tabIndex={0}
      >
        <table className="data-table strength-seeding-table">
          <thead>
            <tr>
              <th scope="col">Entrant</th>
              <th scope="col" className="num">
                Pool place
              </th>
              <th scope="col" className="num">
                Conservative WHR
              </th>
              <th scope="col" className="num">
                Combined score
              </th>
              <th scope="col" className="num">
                Pool-place seed
              </th>
              <th scope="col" className="num">
                Combined rank
              </th>
              <th scope="col" className="num">
                Draw seed
              </th>
            </tr>
          </thead>
          <tbody>
            {seeding.seeds.map((seed) => (
              <tr key={seed.playerId}>
                <th scope="row">{name(seed.playerId)}</th>
                <td className="num">{seed.place}</td>
                <td className="num">
                  {seed.strength.toFixed(1)}
                  {seed.strengthSource === 'prior' ? ' (prior)' : ''}
                </td>
                <td className="num">{seed.combinedScore.toFixed(1)}</td>
                <td className="num">{seed.poolPlaceSeed}</td>
                <td className="num">{seed.provisionalSeed}</td>
                <td className="num">{seed.bracketSeed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>Pool-place byes · {byeNames(seeding.comparison.poolPlaces.byes)}</p>
      <p>Combined byes · {byeNames(seeding.comparison.combined.byes)}</p>
      <p>
        Earliest possible rematches by round · Pool place{' '}
        {meetingCounts(seeding.comparison.poolPlaces.rematchesByRound)}
        {' · Combined '}
        {meetingCounts(seeding.comparison.combined.rematchesByRound)}.
      </p>
      <p>
        Nearby seeds can swap to avoid early rematches. The bye recipients and top seed paths stay
        fixed.
      </p>
    </Disclosure>
  );
}
