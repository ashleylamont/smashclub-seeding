import type { EventPlanView } from '../../../lib/apiTypes';

export function PairRatingEvidence({ entry }: { entry: EventPlanView['entries'][number] }) {
  const rating = entry.pairRating;
  if (!rating) return <span className="muted">Breakdown unavailable for this frozen roster.</span>;
  const adjustment = Math.round(rating.adjustment);
  return (
    <>
      <div>
        {rating.playedSets === 0
          ? 'No prior pair results'
          : `${rating.playedSets} prior played ${rating.playedSets === 1 ? 'set' : 'sets'} · ${rating.eventDays} ${rating.eventDays === 1 ? 'night' : 'nights'}`}
      </div>
      <div className="muted">
        Singles average {Math.round(rating.baselineMean)} ± {Math.round(rating.baselineSd)}
      </div>
      <div className="muted">
        {rating.enabled
          ? `Mean adjustment ${adjustment >= 0 ? '+' : ''}${adjustment} · pair SD ${Math.round(rating.adjustmentSd)}`
          : 'Pair model off'}
      </div>
    </>
  );
}
