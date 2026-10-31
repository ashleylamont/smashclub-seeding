import { Disclosure } from './ui/Disclosure';
import { Select, SelectItem } from './ui/Select';
import { Input } from './ui/Input';
import { Button } from './ui/Button';
import { EventScoreCard } from './EventScoreCard';
import { PlayerMatchFilter } from './PlayerMatchFilter';
import { PoolFilter } from './PoolStationQueue';
import { scoreApprovalPolicy } from '../lib/poolFlow';
import { matchStatus, matchStation } from '../lib/playerMatchView';
import type { PlayerEventHub, PublicEventSnapshot } from '../lib/usePlayerEventHub';

export function PlayerHubMatches({
  hub,
  data,
}: {
  hub: PlayerEventHub;
  data: PublicEventSnapshot;
}) {
  const {
    players,
    player,
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
    waitingMatch,
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
  } = hub;
  return (
    <section id="my-matches" aria-label="Find my matches and report scores">
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
      {playerName && (
        <aside className="card player-event-progress" aria-label="Your progress">
          <h2>{playerName}’s progress</h2>
          <p>
            {completed} of {playerMatches.length} matches complete
          </p>
          <progress
            value={completed}
            max={Math.max(1, playerMatches.length)}
            aria-label="Your matches completed"
          />
          <p>
            {nextMatch ? (
              <>
                {matchStatus(data, nextMatch)} · {nextMatch.label}
                {matchStation(data, nextMatch).name
                  ? ` · ${matchStation(data, nextMatch).name}`
                  : ''}
              </>
            ) : closed ? (
              'This event is closed. Your recorded results and standings remain below.'
            ) : waitingMatch ? (
              `Waiting for a confirmed pairing · ${waitingMatch.label}. Follow the published draw below.`
            ) : (
              'Your scheduled matches are complete. Check your results and published bracket below; pool results do not imply a next-stage seed.'
            )}
          </p>
          {nextMatch && <Button onClick={() => chooseMatch(nextMatch.id)}>Find next match</Button>}
        </aside>
      )}
      <section className="pool-score-selection">
        <div className="player-matches-heading">
          <h2>{playerName ? `${playerName}’s matches` : 'Matches & results'}</h2>
          {playerName && (
            <p>
              {visible.length} {visible.length === 1 ? 'match' : 'matches'} in this view · station
              calls first
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
                Next & recent matches include every stage. The pool filter refines standings and
                station history.
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
                  <SelectItem value="queue">Station matches & my reports</SelectItem>
                  <SelectItem value="matches">
                    {hasAutomaticReports ? 'All matches & results' : 'All open matches'}
                  </SelectItem>
                  <SelectItem value="results">Recorded results</SelectItem>
                  <SelectItem value="mine" disabled={!player}>
                    Selected player’s next & recent matches
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
              unavailableMessage={
                reporter
                  ? 'Match reporting is currently unavailable. Your score draft is kept while live updates recover.'
                  : 'Scan a guest reporting QR to start matches and report scores.'
              }
              pendingMessage={
                reporter === 'signed-in'
                  ? 'Score submitted for TO approval. An organiser can correct or reject it if needed.'
                  : undefined
              }
              onSubmit={(input) => submitScore(match.id, input)}
              approvalPolicy={!closed && playOpen ? scoreApprovalPolicy(data, match) : 'review'}
              match={match}
              report={ownReports?.find((report) => report.matchId === match.id)}
              status={matchStatus(data, match)}
              station={matchStation(data, match).name ?? undefined}
            />
          ))}
        </div>
        {hiddenHistory > 0 && (
          <p className="player-match-history">
            Showing your upcoming matches, recent results and submitted reports.{' '}
            <Button onClick={() => setView('results')}>View all your recorded results</Button>
          </p>
        )}
        {!visible.length && (
          <p className="card">
            {player
              ? 'No matches for this player in this view. Try Selected player’s next & recent matches or clear the pool and station filters.'
              : view === 'reports'
                ? 'Your submitted scores will appear here.'
                : 'No matches in this view yet. Choose a pool, search a player, or select All open matches.'}
          </p>
        )}
      </section>
    </section>
  );
}
