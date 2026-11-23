import { Disclosure } from '../../components/ui/Disclosure';
import type { trpc } from '../../lib/trpc';

type Preview = Awaited<ReturnType<typeof trpc.eventOps.native.preview.query>>;
type Combined = Extract<Preview, { seedPolicy: 'pool_place_whr_v1' }>;
type CombinedBracket = Combined['brackets'][number];
type Seeding = NonNullable<CombinedBracket['strengthSeeding']>;
type QualifierSlots = CombinedBracket['qualifierSlots'];

function meetingCounts(rounds: number[]) {
  return rounds.some(Boolean)
    ? rounds.map((count, i) => `R${i + 1}: ${count}`).join(' · ')
    : 'None';
}

function openingRematchNotes(seeding: Seeding, qualifierSlots: QualifierSlots) {
  const { byes, rematchesByRound } = seeding.comparison.combined;
  const openingRematches = rematchesByRound[0] ?? 0;
  if (!openingRematches) return [];

  const notes: string[] = [];
  let forced = 0;
  if (qualifierSlots?.length === seeding.seeds.length) {
    if (qualifierSlots.every(({ poolId }) => poolId === qualifierSlots[0]?.poolId))
      return ['All qualifiers came from one pool, so every opening match is a rematch.'];

    const byeRecipients = new Set(byes);
    const openingSeeds = seeding.seeds.filter(({ playerId }) => !byeRecipients.has(playerId));
    const openingCounts = new Map<string, number>();
    for (const { bracketSeed } of openingSeeds) {
      // Qualifier sources stay in draw-seed order when a replay replaces an entrant.
      const slot = qualifierSlots[bracketSeed - 1];
      if (slot) openingCounts.set(slot.poolId, (openingCounts.get(slot.poolId) ?? 0) + 1);
    }
    const largestPool = Math.max(0, ...openingCounts.values());
    // Each opening match has room for one entrant from this pool without a repeat.
    forced = Math.max(0, largestPool - openingSeeds.length / 2);
    if (forced > 0) {
      const byeLabel = byes.length === 1 ? 'one fixed bye' : `${byes.length} fixed byes`;
      if (openingSeeds.length === 2) {
        notes.push(
          `The ${byeLabel} ${byes.length === 1 ? 'leaves' : 'leave'} two entrants in the opening round. Both came from the same pool, so their rematch is unavoidable.`,
        );
      } else {
        const fixedByes = byes.length ? `With ${byeLabel}, ` : '';
        const entrants = `${largestPool} of the ${openingSeeds.length} entrants playing in the opening round came from the same pool.`;
        notes.push(
          `${fixedByes}${entrants} At least ${forced} opening-round ${forced === 1 ? 'rematch is' : 'rematches are'} unavoidable.`,
        );
      }
    }
  }

  const retained = openingRematches - forced;
  if (retained > 0)
    notes.push(
      `The combined draw retains ${retained} opening-round pool ${retained === 1 ? 'rematch' : 'rematches'}${forced > 0 ? ' beyond that minimum' : ''}.`,
    );
  return notes;
}

export function StrengthFinalsReview({
  seeding,
  qualifierSlots,
  name,
  historical,
}: {
  seeding: Seeding;
  qualifierSlots: QualifierSlots;
  name: (id: string) => string;
  historical: boolean;
}) {
  const byeNames = (ids: string[]) => ids.map(name).join(', ') || 'None';
  return (
    <Disclosure title={historical ? 'Original seeding and byes' : 'Compare seeding and byes'}>
      {historical && (
        <p>
          These seeds are the original draw record. See the current bracket for updated pairings.
        </p>
      )}
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
      {openingRematchNotes(seeding, qualifierSlots).map((note) => (
        <p key={note}>{note}</p>
      ))}
      <p>
        The combined draw can swap nearby seeds to avoid early rematches. Its bye recipients and top
        seed paths stay fixed.
      </p>
    </Disclosure>
  );
}
