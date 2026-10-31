import { matchParticipantName, matchPresentation } from '../../lib/matchPresentation';
import { useConfirmation } from '../../lib/confirmation';
import { Select, SelectItem } from '../../components/ui/Select';
import { Button } from '../../components/ui/Button';
import { trpc } from '../../lib/trpc';
import { MatchScoring } from './OpsMatchScoring';
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
  const eligible = eligibleStations(match, stations);
  const label = matchLabel(match, canStart);
  return (
    <article className={`card ops-match ops-match-${match.status}`}>
      <div className="ops-match-meta">
        <span>{match.label}</span>
        <span className="chip">{label}</span>
      </div>
      <MatchContestants match={match} />
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
      <MatchScoring match={match} disabled={disabled} act={act}>
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
      </MatchScoring>
    </article>
  );
}

function MatchContestants({ match }: { match: Match }) {
  const presentation = matchPresentation(match);
  return (
    <>
      {[
        { name: match.player1Name, score: match.score1 },
        { name: match.player2Name, score: match.score2 },
      ].map((player, index) => (
        <div className="ops-contestant" key={index}>
          <strong>{matchParticipantName(match, index === 0 ? 0 : 1)}</strong>
          {presentation.showScores && <b>{player.score ?? '–'}</b>}
        </div>
      ))}
      {presentation.result && <p>{presentation.result}</p>}
    </>
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
  const presentation = matchPresentation(match);
  if (presentation.status) return presentation.status;
  if (match.called) return 'Called';
  if (match.status === 'playing') return 'Playing now';
  return canStart ? 'Ready to start' : 'Waiting';
}
