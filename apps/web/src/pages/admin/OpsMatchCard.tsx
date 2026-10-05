import { useConfirmation } from '../../lib/confirmation';
import { Select, SelectItem } from '../../components/ui/Select';
import { Button } from '../../components/ui/Button';
import { useState } from 'react';
import { trpc } from '../../lib/trpc';
import { ScoreFields, type ScoreInputValue } from '../../components/ScoreFields';
type Overview = Awaited<ReturnType<typeof trpc.eventOps.overview.query>>;
type Match = Overview['matches'][number];
type Action = (work: () => Promise<unknown>, message?: string) => Promise<void>;
export function MatchCard({
  match,
  stations,
  disabled,
  canStart,
  native,
  act,
}: {
  match: Match;
  stations: Overview['stations'];
  disabled: boolean;
  canStart: boolean;
  native: boolean;
  act: Action;
}) {
  const confirmAction = useConfirmation();
  const [editing, setEditing] = useState<'live' | 'final' | null>(null);
  const [revision, setRevision] = useState(match.revision);
  const [progressRevision, setProgressRevision] = useState(match.progressRevision);
  const [score1, setScore1] = useState<ScoreInputValue>(match.score1 ?? 0);
  const [score2, setScore2] = useState<ScoreInputValue>(match.score2 ?? 0);
  const [outcome, setOutcome] = useState<'played' | 'forfeit' | 'bye'>('played');
  const [winnerId, setWinnerId] = useState(match.winnerId ?? match.player1Id ?? '');
  const [requestId, setRequestId] = useState('');
  const stale =
    editing !== null &&
    (revision !== match.revision ||
      (editing === 'live' && progressRevision !== match.progressRevision));
  const requireDecisive = editing === 'final' && outcome === 'played';
  const begin = (mode: 'live' | 'final') => {
    setEditing(mode);
    setRevision(match.revision);
    setProgressRevision(match.progressRevision);
    setScore1(match.score1 ?? 0);
    setScore2(match.score2 ?? 0);
    setOutcome(match.outcome ?? 'played');
    setWinnerId(match.winnerId ?? match.player1Id ?? '');
    setRequestId(crypto.randomUUID());
  };
  const eligible = eligibleStations(match, stations);
  const label = matchLabel(match, canStart);
  return (
    <article className={`card ops-match ops-match-${match.status}`}>
      <div className="ops-match-meta">
        <span>{match.label}</span>
        <span className="chip">{label}</span>
      </div>
      <div className="ops-contestant">
        <strong>{match.player1Name || 'Awaiting qualifier'}</strong>
        <b>{match.score1 ?? '–'}</b>
      </div>
      <div className="ops-contestant">
        <strong>{match.player2Name || 'Awaiting qualifier'}</strong>
        <b>{match.score2 ?? '–'}</b>
      </div>
      {match.status === 'playing' && (
        <p className="ops-delivery">Live game score · match still in progress</p>
      )}
      {!native && (
        <p className="ops-delivery">
          {match.syncState === 'synced'
            ? 'Confirmed in linked bracket'
            : 'Saved in Nemesis · external bracket not yet reconciled'}
        </p>
      )}
      {match.status !== 'playing' &&
        match.status !== 'complete' &&
        match.availability.reasons.length > 0 && (
          <ul className="ops-wait-reasons">
            {match.availability.reasons.map((reason) => (
              <li key={`${reason.code}:${reason.message}`}>{reason.message}</li>
            ))}
          </ul>
        )}
      <label className="ops-station">
        Station
        <Select
          aria-label={`Station for ${match.label}`}
          value={match.stationId ?? ''}
          disabled={disabled || match.status === 'complete'}
          onValueChange={(selectedValue) =>
            void act(() =>
              trpc.eventOps.updateMatch.mutate({
                matchId: match.id,
                expectedRevision: match.revision,
                expectedResourceRevision: match.resourceRevision,
                status:
                  match.status === 'playing'
                    ? 'playing'
                    : match.status === 'blocked'
                      ? 'blocked'
                      : 'ready',
                stationId: selectedValue || null,
                ...(match.blockedReason ? { blockedReason: match.blockedReason } : {}),
              }),
            )
          }
        >
          <SelectItem value="">Choose a free station</SelectItem>
          {match.stationId && !eligible.some((station) => station.id === match.stationId) && (
            <SelectItem value={match.stationId} disabled>
              {stations.find((station) => station.id === match.stationId)?.name ?? 'Station'} —
              unavailable
            </SelectItem>
          )}
          {eligible.map((station) => (
            <SelectItem key={station.id} value={station.id}>
              {station.name}
            </SelectItem>
          ))}
        </Select>
      </label>
      <div className="ops-match-actions">
        {match.status !== 'complete' && (
          <Button
            size="small"
            disabled={disabled || (match.status !== 'playing' && !canStart)}
            title={
              !canStart && match.status !== 'playing'
                ? match.availability.reasons.map((reason) => reason.message).join(' ')
                : undefined
            }
            onClick={() =>
              void act(() =>
                trpc.eventOps.updateMatch.mutate({
                  matchId: match.id,
                  expectedRevision: match.revision,
                  expectedResourceRevision: match.resourceRevision,
                  status: match.status === 'playing' ? 'ready' : 'playing',
                  stationId: match.stationId,
                }),
              )
            }
          >
            {match.status === 'playing' ? 'Return to queue' : 'Start match'}
          </Button>
        )}
        {!native &&
          match.status === 'blocked' &&
          match.player1Id &&
          match.player2Id &&
          match.blockedReason?.startsWith('Imported bracket participants changed.') && (
            <Button
              size="small"
              disabled={disabled}
              onClick={async () => {
                if (
                  await confirmAction(
                    `Confirm that this match is now ${match.player1Name} vs ${match.player2Name}? It will return to the queue with its previous live score cleared.`,
                  )
                )
                  void act(
                    () =>
                      trpc.eventOps.updateMatch.mutate({
                        matchId: match.id,
                        expectedRevision: match.revision,
                        status: 'ready',
                      }),
                    'Players confirmed · match returned to the queue',
                  );
              }}
            >
              Confirm players and return to queue
            </Button>
          )}
        {match.status === 'playing' && (
          <Button size="small" disabled={disabled} onClick={() => begin('live')}>
            Update live score
          </Button>
        )}
        <Button size="small" disabled={disabled} onClick={() => begin('final')}>
          {match.status === 'complete' ? 'Correct score' : 'Finish match'}
        </Button>
      </div>
      {editing && (
        <form
          className="ops-score-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (score1 === '' || score2 === '') return;
            void act(
              async () => {
                if (editing === 'live')
                  await trpc.eventOps.updateLiveScore.mutate({
                    matchId: match.id,
                    expectedRevision: revision,
                    expectedProgressRevision: progressRevision,
                    score1,
                    score2,
                  });
                else
                  await trpc.eventOps.reportScore.mutate({
                    matchId: match.id,
                    expectedRevision: revision,
                    requestId,
                    score1,
                    score2,
                    outcome,
                    ...(outcome !== 'played' ? { winnerId } : {}),
                  });
                setEditing(null);
              },
              editing === 'live'
                ? 'Live score updated · match still playing'
                : 'Score recorded locally',
            );
          }}
        >
          <strong>
            {editing === 'live'
              ? 'Update the score without finishing the match'
              : 'Confirm the final result and finish this match'}
          </strong>
          {stale && (
            <p role="alert" className="error-text">
              Another TO updated this match. Cancel and reopen to use the latest score.
            </p>
          )}
          <ScoreFields
            player1Name={match.player1Name}
            player2Name={match.player2Name}
            score1={score1}
            score2={score2}
            requireDecisive={requireDecisive}
            onScore1={(value) => {
              setScore1(value);
              setRequestId(crypto.randomUUID());
            }}
            onScore2={(value) => {
              setScore2(value);
              setRequestId(crypto.randomUUID());
            }}
          />
          {editing === 'final' && (
            <>
              <label>
                Result type
                <Select
                  value={outcome}
                  onValueChange={(selectedValue) => {
                    setOutcome(selectedValue as typeof outcome);
                    setRequestId(crypto.randomUUID());
                  }}
                >
                  <SelectItem value="played">Played match</SelectItem>
                  <SelectItem value="forfeit">Forfeit</SelectItem>
                  <SelectItem value="bye">Bye</SelectItem>
                </Select>
              </label>
              {outcome !== 'played' && (
                <label>
                  Winner
                  <Select
                    value={winnerId}
                    onValueChange={(selectedValue) => {
                      setWinnerId(selectedValue);
                      setRequestId(crypto.randomUUID());
                    }}
                  >
                    {[
                      { id: match.player1Id, name: match.player1Name },
                      { id: match.player2Id, name: match.player2Name },
                    ]
                      .filter((player) => player.id)
                      .map((player) => (
                        <SelectItem key={player.id!} value={player.id!}>
                          {player.name}
                        </SelectItem>
                      ))}
                  </Select>
                </label>
              )}
            </>
          )}
          <div className="ops-match-actions">
            <Button
              type="submit"
              variant="primary"
              disabled={
                disabled ||
                stale ||
                [score1, score2].includes('') ||
                (requireDecisive && score1 === score2)
              }
            >
              {editing === 'live' ? 'Save live score' : 'Confirm result'}
            </Button>
            <Button type="button" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </article>
  );
}

function eligibleStations(match: Match, stations: Overview['stations']) {
  return stations.filter(
    (station) =>
      (station.status === 'free' || station.currentMatchId === match.id) &&
      (match.availability.eligibleStationIds.includes(station.id) ||
        station.currentMatchId === match.id),
  );
}
function matchLabel(match: Match, canStart: boolean) {
  if (match.status === 'complete') return 'Finished';
  if (match.status === 'playing') return 'Playing now';
  return canStart ? 'Ready to start' : 'Waiting';
}
