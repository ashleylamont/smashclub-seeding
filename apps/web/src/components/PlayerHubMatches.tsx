import type { ReactNode } from 'react';
import { Disclosure } from './ui/Disclosure';
import { Progress } from './ui/Progress';
import { Select, SelectItem } from './ui/Select';
import { Input } from './ui/Input';
import { Button } from './ui/Button';
import { EventScoreCard } from './EventScoreCard';
import { PlayedCharacterReport } from './PlayedCharacterReport';
import { scoreReportPlayers } from '../lib/scoreReportPlayers';
import { PlayerMatchFilter } from './PlayerMatchFilter';
import { PoolFilter } from './PoolStationQueue';
import { scoreApprovalPolicy } from '../lib/poolFlow';
import { matchStatus, matchStation } from '../lib/playerMatchView';
import { nextMeaningfulMatch } from '../lib/matchPresentation';
import { playerJourney } from '../lib/playerJourney';
import type { PlayerEventHub, PublicEventSnapshot } from '../lib/usePlayerEventHub';

export function PlayerHubMatches({
  hub,
  data,
  reportingStatus,
}: {
  hub: PlayerEventHub;
  data: PublicEventSnapshot;
  reportingStatus: ReactNode;
}) {
  const {
    players,
    player,
    selectedPlayer,
    playerName,
    setSelectedPlayer,
    view,
    setView,
    search,
    setSearch,
    selectedPool,
    setSelectedPool,
    setSelectedStation,
    setSelectedMatch,
    playerMatches,
    completed,
    nextMatch,
    hiddenHistory,
    chooseMatch,
    visible,
    stationId,
    hasAutomaticReports,
    reportingIdentity,
    canWrite,
    closed,
    reporter,
    submitScore,
    playOpen,
    ownReports,
    claim,
    signedIn,
  } = hub;
  const journey = player ? playerJourney(data, player) : undefined;
  return (
    <section id="my-matches" aria-label="Find my matches and report scores">
      {reportingStatus}
      <PlayerMatchFilter
        players={players}
        value={player}
        onChange={(id) => {
          setSelectedPlayer(id);
          setView(id ? 'mine' : 'matches');
          setSelectedPool('');
          setSelectedStation('');
          setSelectedMatch(null);
          setSearch('');
        }}
      />
      {selectedPlayer && !player && (
        <p className="card">
          Your saved player is not in the current draw. Showing Everyone until their pairings
          appear. Choose Everyone to clear the saved selection.
        </p>
      )}
      {playerName && (
        <aside
          className="card player-event-progress"
          aria-label="Your progress"
          data-journey-state={journey?.state}
        >
          <h2>{playerName}’s progress</h2>
          <p>
            {completed} of {playerMatches.length} matches complete
          </p>
          <Progress
            value={completed}
            max={Math.max(1, playerMatches.length)}
            label="Your matches completed"
          />
          <p>{journey?.summary}</p>
          {journey?.consequences.length ? (
            <dl className="player-event-next-rounds" aria-label="Possible next rounds">
              {journey.consequences.map((item) => (
                <div key={`${item.outcome}:${item.label}`}>
                  <dt>{item.outcome}</dt>
                  <dd>{item.label}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {nextMatch && journey?.state === 'active' && (
            <Button onClick={() => chooseMatch(nextMatch.id)}>Find next match</Button>
          )}
        </aside>
      )}
      <section className="pool-score-selection">
        <div className="player-matches-heading">
          <h2>{playerName ? `${playerName}’s matches` : 'Matches & results'}</h2>
          {playerName && (
            <p>
              {visible.length} {visible.length === 1 ? 'match' : 'matches'} in this view
              {!closed && ' · station calls first'}
            </p>
          )}
        </div>
        <Disclosure
          title={
            <>
              Match filters{selectedPool ? ' · one pool selected' : ''}
              {stationId ? ' · one station selected' : ''}
            </>
          }
          className="player-match-refine"
          key={player ? 'focused' : 'everyone'}
          defaultOpen={!player}
        >
          <div className="player-match-controls">
            {player && view === 'mine' && (
              <p className="muted">
                {closed
                  ? 'The pool filter refines standings and schedule history.'
                  : 'Next & recent matches include every stage. The pool filter refines standings and station history.'}
              </p>
            )}
            <div className="player-match-secondary-filters">
              <PoolFilter
                data={data}
                value={selectedPool}
                onChange={(value) => {
                  setSelectedPool(value);
                  setSelectedMatch(null);
                }}
              />
              <label className="pool-flow-filter">
                Station
                <Select value={stationId} onValueChange={setSelectedStation}>
                  <SelectItem value="">All stations</SelectItem>
                  {data.stations.map((station) => (
                    <SelectItem key={station.id} value={station.id}>
                      {station.name}
                    </SelectItem>
                  ))}
                </Select>
              </label>
            </div>
            <div className="ops-toolbar">
              <label>
                View
                <Select aria-label="Match view" value={view} onValueChange={setView}>
                  <SelectItem value="queue">
                    {closed ? 'Station pairings & my reports' : 'Station matches & my reports'}
                  </SelectItem>
                  <SelectItem value="matches">
                    {hasAutomaticReports
                      ? 'All matches & results'
                      : closed
                        ? 'Unfinished matches & my reports'
                        : 'All open matches'}
                  </SelectItem>
                  <SelectItem value="results">Recorded results</SelectItem>
                  <SelectItem value="mine" disabled={!player}>
                    {closed
                      ? 'Selected player’s match history'
                      : 'Selected player’s next & recent matches'}
                  </SelectItem>
                  <SelectItem value="reports">My reports</SelectItem>
                </Select>
              </label>
              <label className="ops-search">
                Search matches
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Player, pool or match…"
                />
              </label>
            </div>
          </div>
        </Disclosure>
        <div className="ops-match-grid">
          {visible.map((match) => (
            <EventScoreCard
              key={match.id}
              reportingIdentity={reportingIdentity}
              enabled={
                canWrite && !closed && ['ready', 'playing', 'complete'].includes(match.status)
              }
              unavailableMessage={null}
              pendingMessage={
                reporter === 'signed-in'
                  ? 'Score submitted for TO approval. An organiser can correct or reject it if needed.'
                  : undefined
              }
              onSubmit={(input) => submitScore(match.id, input)}
              approvalPolicy={!closed && playOpen ? scoreApprovalPolicy(data, match) : 'review'}
              match={match}
              memberNames={data.memberNames}
              playedCharacters={data.charactersPlayed?.[match.id]}
              lateReport={
                data.plan.liveOwned &&
                data.plan.status !== 'cancelled' &&
                match.status === 'complete' &&
                match.outcome === 'played' &&
                claim &&
                scoreReportPlayers(match, data.memberNames).some(
                  ({ id }) => id === claim.playerId,
                ) && (
                  <PlayedCharacterReport
                    key={signedIn?.user.id}
                    target={{ kind: 'native', planId: data.plan.id, matchId: match.id }}
                    players={scoreReportPlayers(match, data.memberNames)}
                  />
                )
              }
              nextMatch={closed ? undefined : nextMeaningfulMatch(data.matches, match)}
              report={ownReports?.find((report) => report.matchId === match.id)}
              recordedOnly={closed}
              status={matchStatus(data, match)}
              station={matchStation(data, match, closed).name ?? undefined}
            />
          ))}
        </div>
        {hiddenHistory > 0 && (
          <p className="player-match-history">
            {closed
              ? 'Showing your recent results and submitted reports.'
              : 'Showing your upcoming matches, recent results and submitted reports.'}{' '}
            <Button onClick={() => setView('results')}>View all your recorded results</Button>
          </p>
        )}
        {!visible.length && (
          <p className="card">
            {closed ? (
              <>
                No matches in this view. Change the filters or go to{' '}
                <a className="link-button" href="#event-results">
                  Recorded results
                </a>
                .
              </>
            ) : player ? (
              'No matches for this player in this view. Try Selected player’s next & recent matches or clear the pool and station filters.'
            ) : view === 'reports' ? (
              'Your submitted scores will appear here.'
            ) : (
              'No matches in this view yet. Choose a pool, search a player, or select All open matches.'
            )}
          </p>
        )}
      </section>
    </section>
  );
}
