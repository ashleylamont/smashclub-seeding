import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Button } from '../components/ui/Button';
import { Dialog } from '../components/ui/Dialog';
import { LoadingState, Notice } from '../components/ui/Feedback';
import { Field } from '../components/ui/Field';
import { PageHeader } from '../components/ui/PageHeader';
import { formatDate } from '../lib/format';
import { trpc } from '../lib/trpc';
import './HeadToHeadPage.css';

type Comparison = Awaited<ReturnType<typeof trpc.public.headToHead.query>>;
type Player = NonNullable<Comparison['players'][number]>;
type ReadyComparison = Extract<Comparison, { status: 'ready' }>;

function PlayerPicker({
  position,
  player,
  otherId,
  onPick,
}: {
  position: 'first' | 'second';
  player: Player | null;
  otherId?: string;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const term = query.trim();
  const search = useQuery({
    queryKey: ['searchPlayers', term],
    queryFn: () => trpc.public.searchPlayers.query({ query: term }),
    enabled: open && term.length > 0,
  });
  const choices = search.data?.filter(({ id }) => id !== otherId) ?? [];
  const title = `Choose ${position} player`;
  const pick = (id: string) => {
    setOpen(false);
    onPick(id);
  };
  return (
    <Dialog
      title={title}
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (value) setQuery('');
      }}
      trigger={
        <Button aria-label={player ? `Change ${position} player, ${player.name}` : title}>
          <span>{player ? player.name : title}</span>
          {player?.companyCode && <span className="muted">{player.companyCode}</span>}
        </Button>
      }
    >
      <Field
        autoFocus
        label="Search by public alias"
        maxLength={100}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && choices.length === 1) pick(choices[0]!.id);
        }}
      />
      {term.length > 0 && search.isPending && <LoadingState>Searching players…</LoadingState>}
      {search.isError && (
        <Notice tone="danger">
          Player search is unavailable.{' '}
          <Button variant="plain" onClick={() => void search.refetch()}>
            Try again
          </Button>
        </Notice>
      )}
      {search.isSuccess && choices.length === 0 && <p>No other players match this alias.</p>}
      {choices.length > 0 && (
        <ul className="h2h-player-results">
          {choices.map((choice) => (
            <li key={choice.id}>
              <Button onClick={() => pick(choice.id)}>
                <span>{choice.name}</span>
                {choice.companyCode && <span className="muted">{choice.companyCode}</span>}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

export function HeadToHeadPage() {
  const search = useSearch({ from: '/head-to-head' });
  const navigate = useNavigate({ from: '/head-to-head' });
  const anyPlayer = Boolean(search.first || search.second);
  const query = useQuery({
    queryKey: ['headToHead', search.first, search.second],
    queryFn: () => trpc.public.headToHead.query(search),
    enabled: anyPlayer,
    placeholderData: keepPreviousData,
  });
  const comparison = query.isPlaceholderData ? undefined : query.data;
  const selected = (position: 'first' | 'second') =>
    comparison?.players[position === 'first' ? 0 : 1] ??
    query.data?.players.find((player) => player?.id === search[position]) ??
    null;
  const first = selected('first');
  const second = selected('second');
  useEffect(() => {
    const canonical = { first: first?.id ?? search.first, second: second?.id ?? search.second };
    if (canonical.first !== search.first || canonical.second !== search.second)
      void navigate({ search: canonical, replace: true });
  }, [first?.id, second?.id, navigate, search.first, search.second]);

  return (
    <div className="page h2h-page">
      <PageHeader
        title="Head to head"
        description="Compare recorded singles results and the current WHR estimate for two players."
      />
      <section className="card h2h-pickers" aria-label="Players to compare">
        <div className="h2h-picker">
          <span className="muted">First player</span>
          <PlayerPicker
            position="first"
            player={first}
            otherId={second?.id}
            onPick={(id) => void navigate({ search: { ...search, first: id } })}
          />
        </div>
        <div className="h2h-picker">
          <span className="muted">Second player</span>
          <PlayerPicker
            position="second"
            player={second}
            otherId={first?.id}
            onPick={(id) => void navigate({ search: { ...search, second: id } })}
          />
        </div>
        {first && second && first.id !== second.id && (
          <Button asChild>
            <Link to="/head-to-head" search={{ first: second.id, second: first.id }}>
              Swap players
            </Link>
          </Button>
        )}
      </section>
      {anyPlayer && (query.isPending || query.isPlaceholderData) && (
        <LoadingState>Loading comparison…</LoadingState>
      )}
      {query.isError && (
        <Notice tone="danger">
          The comparison is unavailable.{' '}
          <Button variant="plain" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </Notice>
      )}
      {comparison?.status === 'missing_player' && (
        <Notice tone="warning">A selected player is unavailable. Choose another profile.</Notice>
      )}
      {comparison?.status === 'same_player' && (
        <Notice>Choose two different players to compare their results.</Notice>
      )}
      {comparison?.status === 'unavailable' && (
        <Notice tone="warning">The selected profiles could not be compared.</Notice>
      )}
      {comparison?.status === 'ready' && <ComparisonResults data={comparison} />}
    </div>
  );
}

function chanceLabel(percent: number) {
  if (percent === 0) return '<1%';
  if (percent === 100) return '>99%';
  return `${percent}%`;
}

function ComparisonResults({ data }: { data: ReadyComparison }) {
  const { players, history, forecast } = data;
  const total = history ? history.wins[0] + history.wins[1] : 0;
  const firstChance = forecast ? Math.round(forecast.firstWinChance * 100) : null;

  return (
    <>
      <div className="h2h-summary">
        <section className="card" aria-labelledby="h2h-history">
          <h2 id="h2h-history">Played singles</h2>
          {!history ? (
            <p>This pair has more result records than the comparison can load.</p>
          ) : total === 0 ? (
            <p>No recorded singles meetings for this pair.</p>
          ) : (
            <>
              <dl className="h2h-figures">
                {players.map((player, index) => (
                  <div key={player.id}>
                    <dt>
                      <Link to="/players/$playerId" params={{ playerId: player.id }}>
                        {player.name}
                      </Link>
                    </dt>
                    <dd className="num">
                      {history.wins[index]} set {history.wins[index] === 1 ? 'win' : 'wins'}
                    </dd>
                    <dd className="muted">
                      {history.scoredMeetings > 0
                        ? `${history.gamesWon[index]} game ${history.gamesWon[index] === 1 ? 'win' : 'wins'}`
                        : 'Game wins unavailable'}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="muted">
                Game scores recorded in {history.scoredMeetings} of {total} sets.
              </p>
            </>
          )}
        </section>
        <section className="card" aria-labelledby="h2h-forecast">
          <h2 id="h2h-forecast">Current WHR estimate</h2>
          {forecast && firstChance !== null ? (
            <>
              <p>Estimated chance of winning the next singles set.</p>
              <dl className="h2h-figures">
                {players.map((player, index) => (
                  <div key={player.id}>
                    <dt>{player.name}</dt>
                    <dd className="num">
                      {chanceLabel(index === 0 ? firstChance : 100 - firstChance)}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="muted">
                Ratings published{' '}
                <time dateTime={forecast.ratedAt}>{formatDate(forecast.ratedAt)}</time>. WHR uses
                each player’s rated singles results. Sparse results and uncertain ratings make the
                estimate less informative.
                {forecast.provisional && ' At least one of these ratings is provisional.'}
              </p>
            </>
          ) : (
            <p>
              An estimate needs a current published WHR rating with played sets for each player.
            </p>
          )}
        </section>
      </div>
      {history && history.recent.length > 0 && (
        <section className="card h2h-recent" aria-labelledby="h2h-recent">
          <h2 id="h2h-recent">Recent meetings</h2>
          {history.recent.length < total && (
            <p className="muted">
              Latest {history.recent.length} of {total} played sets.
            </p>
          )}
          <ul>
            {history.recent.map((meeting) => (
              <li key={meeting.id}>
                <div>
                  <Link to="/tournaments/$slug" params={{ slug: meeting.slug }}>
                    {meeting.event}
                  </Link>
                  {meeting.date && (
                    <time className="muted" dateTime={meeting.date}>
                      {formatDate(meeting.date)}
                    </time>
                  )}
                </div>
                <div>
                  <strong>{players[meeting.winner].name} won</strong>
                  <span className="muted">
                    {meeting.games
                      ? `${meeting.games[meeting.winner]}–${meeting.games[meeting.winner === 0 ? 1 : 0]}`
                      : 'Game score unavailable'}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
