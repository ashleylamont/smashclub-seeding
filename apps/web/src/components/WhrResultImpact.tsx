import { useQuery } from '@tanstack/react-query';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { trpc } from '../lib/trpc';

function effectDescription(points: number) {
  if (Math.abs(points) < 0.01) return 'Little estimated change in skill';
  const direction = points > 0 ? 'higher' : 'lower';
  const rounded = Math.round(Math.abs(points) / 5) * 5;
  return rounded ? `About ${rounded} points ${direction}` : `Slightly ${direction} skill estimate`;
}

function winChance(probability: number) {
  const percent = Math.round(probability * 20) * 5;
  if (percent === 0) return 'less than 5%';
  if (percent === 100) return 'more than 95%';
  return `about ${percent}%`;
}

const unavailableMessage = {
  stale_run: 'The published rating run changed. Refresh the profile to use the latest results.',
  older_run:
    'This rating run predates result impact. An estimate will be available after ratings are recomputed.',
  not_rated: 'There is no rated result for this set.',
  history_changed:
    'The results for this night have changed. Check again after ratings are recomputed.',
  non_converged: 'WHR could not settle on a reliable estimate for this result.',
  history_too_large: 'The history for this night is too large to refit here.',
  busy: 'Result impact is busy. Try again in a moment.',
};

export function WhrResultImpact({
  playerId,
  setId,
  recomputeId,
  onClose,
}: {
  playerId: string;
  setId: string;
  recomputeId: string;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: ['whr-result-impact', recomputeId, setId, playerId],
    queryFn: () => trpc.public.whrResultImpact.query({ playerId, setId, recomputeId }),
    gcTime: 0,
    retry: false,
  });
  const result = query.data;
  const retry = query.isError || (result?.status === 'unavailable' && result.reason === 'busy');
  return (
    <Dialog
      title="WHR impact"
      description="How this set affected the model’s skill estimate for that night."
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {query.isFetching ? (
        <p role="status">Estimating this result’s impact…</p>
      ) : result?.status === 'available' ? (
        <div className="whr-impact-details">
          <p>
            <strong>{effectDescription(result.effectPoints)}</strong> with this result included.
          </p>
          <p>
            {result.firstNight
              ? 'This was your first rated night, so the estimate depends more on the starting prior.'
              : result.preNightSd === null
                ? 'Pre-night uncertainty is unavailable for this rating run.'
                : `Before this night, your estimated skill had an uncertainty band of about ±${Math.round(result.preNightSd * 2)} points.`}
          </p>
          {result.forecast && (
            <p>
              Before the night, WHR put your chance of winning at{' '}
              {winChance(result.forecast.winProbability)} against an opponent rated around{' '}
              {Math.round(result.forecast.opponentSkill / 10) * 10}.
            </p>
          )}
          <p>
            The set counted as ×{result.evidenceWeight.toFixed(1)} evidence. WHR gives more weight
            to clear score margins.
          </p>
          <p className="muted">
            WHR compares the whole night with and without this set. It estimates each set
            separately, so impacts do not add up to the night’s change. Attendance is separate.
          </p>
        </div>
      ) : (
        <>
          <p role="status">
            {result?.status === 'unavailable'
              ? unavailableMessage[result.reason]
              : 'The result impact could not be loaded.'}
          </p>
          {retry && <Button onClick={() => void query.refetch()}>Try again</Button>}
        </>
      )}
    </Dialog>
  );
}
