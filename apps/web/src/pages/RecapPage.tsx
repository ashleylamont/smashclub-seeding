import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { trpc } from '../lib/trpc';
import type { RecapData, RecapFact, RecapFactEntry, RecapPlayer } from '../lib/apiTypes';
import { CharacterIcons } from '../components/CharacterIcons';
import { formatDate } from '../lib/format';
import { downloadBlob, renderShareCard } from '../lib/shareCard';
import './Recap.css';

/**
 * The night in review.
 *
 * Its own route rather than a strip on the tournament page, because the point
 * is that a link to it can be pasted into a chat — which also means it must
 * stand alone: the page never assumes you arrived from the bracket you were
 * watching.
 */
export function RecapPage() {
  const { slug } = useParams({ from: '/recaps/$slug' });

  const query = useQuery({
    queryKey: ['recap', slug],
    queryFn: () => trpc.public.recap.query({ slug }),
  });

  if (query.isPending) return <p className="loading-text">Loading recap…</p>;
  if (query.isError) return <p className="error-text">Failed to load recap: {query.error.message}</p>;
  if (query.data == null) return <p className="error-text">No recap found for this tournament.</p>;

  return <Recap data={query.data} />;
}

/** Facts that head the page rather than sitting in the grid with the rest. */
const HERO_KINDS = new Set<RecapFact['kind']>(['podium']);

function Recap({ data }: { data: RecapData }) {
  const podiums = useMemo(
    () =>
      data.facts
        .map((entry) => entry.fact)
        .filter((fact): fact is Extract<RecapFact, { kind: 'podium' }> => fact.kind === 'podium'),
    [data.facts],
  );

  const storyFacts = useMemo(
    () => data.facts.filter((entry) => !HERO_KINDS.has(entry.fact.kind)),
    [data.facts],
  );

  const tournamentName = useMemo(
    () => new Map(data.tournaments.map((t) => [t.id, t.name])),
    [data.tournaments],
  );

  const headline = data.tournaments[0]?.name ?? 'Club night';
  const eventDate = data.tournaments[0]?.eventDate ?? null;

  return (
    <div className="recap-page">
      <div className="page-header">
        <div>
          <p className="eyebrow">The night in review</p>
          <h1>{headline}</h1>
        </div>
        <ShareBar data={data} headline={headline} podium={podiums[0] ?? null} />
      </div>

      <p className="muted recap-subtitle">
        {formatDate(eventDate)} · {data.entrants} entrants · {data.setsPlayed} sets
        {data.tournaments.length > 1 && ` · ${data.tournaments.length} brackets`}
        {!data.isComplete && <span className="chip chip-warning recap-progress-chip">still in progress</span>}
      </p>

      {podiums.length > 0 && (
        <section className="recap-podiums">
          {podiums.map((podium) => (
            <Podium
              key={podium.tournamentId}
              podium={podium}
              name={tournamentName.get(podium.tournamentId) ?? 'Bracket'}
            />
          ))}
        </section>
      )}

      <section className="section">
        <h2>Highlights</h2>
        {storyFacts.length === 0 ? (
          <p className="muted">
            Nothing to report yet — highlights appear as sets are played and the ratings catch up.
          </p>
        ) : (
          <>
            {/* The most notable fact is the night's lead story, not a card
                among cards — highlights need a front page. */}
            <LeadStory
              entry={storyFacts[0]!}
              bracket={
                storyFacts[0]!.fact.tournamentId
                  ? tournamentName.get(storyFacts[0]!.fact.tournamentId)
                  : null
              }
              multiBracket={data.tournaments.length > 1}
            />
            <ul className="fact-grid">
              {storyFacts.slice(1).map((entry) => (
                <FactCard
                  key={entry.id}
                  entry={entry}
                  bracket={entry.fact.tournamentId ? tournamentName.get(entry.fact.tournamentId) : null}
                  multiBracket={data.tournaments.length > 1}
                />
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="section">
        <h2>Brackets</h2>
        <ul className="recap-bracket-list">
          {data.tournaments.map((tournament) => (
            <li key={tournament.id}>
              <Link to="/tournaments/$slug" params={{ slug: tournament.slug }}>
                {tournament.name}
              </Link>
              {tournament.isRookie && <span className="chip chip-warning">rookie</span>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Podium({ podium, name }: { podium: Extract<RecapFact, { kind: 'podium' }>; name: string }) {
  return (
    <div className="podium card">
      <h3 className="podium-title">{name}</h3>
      <ol className="podium-list">
        {podium.places.map((place) => (
          <li key={`${place.place}-${place.player.name}`} className={`podium-place place-${place.place}`}>
            <span className="podium-rank num">{place.place}</span>
            <span className="podium-player">
              <PlayerName player={place.player} />
              {place.seed != null && <span className="podium-seed">seed {place.seed}</span>}
            </span>
          </li>
        ))}
      </ol>
      {podium.derived && (
        <p className="podium-note muted">
          Placements worked out from the bracket — Challonge did not report them for this event.
        </p>
      )}
    </div>
  );
}

/**
 * The one number that makes a fact land, pulled from its structured payload.
 * "12% win chance" or "0–4 coming in" says more at a glance than a paragraph;
 * this is what separates a highlight from a summary row.
 */
function statOf(fact: RecapFact): { value: string; label: string } | null {
  switch (fact.kind) {
    case 'seed_upset':
      return { value: `#${fact.winnerSeed}`, label: `beat seed #${fact.loserSeed}` };
    case 'rating_upset':
      return { value: `${Math.max(1, Math.round(fact.probability * 100))}%`, label: 'win chance' };
    case 'losers_run':
      return { value: String(fact.wins), label: 'elimination wins in a row' };
    case 'overperformer':
      return { value: `+${fact.placesGained}`, label: 'places over seed' };
    case 'nailbiter':
      return { value: fact.score, label: 'went the distance' };
    case 'clean_sweep':
      return { value: '0', label: 'games dropped' };
    case 'biggest_climb':
      return { value: `+${Math.round(fact.gained)}`, label: 'rating overnight' };
    case 'mover':
      return { value: `▲${fact.placesGained}`, label: `now #${fact.rank}` };
    case 'rivalry':
      return { value: `${fact.aWins}–${fact.bWins}`, label: 'the series so far' };
    case 'breakthrough':
      return { value: `0–${fact.priorLosses}`, label: 'the record coming in' };
    case 'debut':
      return fact.players.length > 1 ? { value: String(fact.players.length), label: 'first-timers' } : null;
    case 'milestone':
      if (fact.milestone === 'peak_rating') return { value: String(Math.round(fact.value)), label: 'career high' };
      return { value: String(fact.value), label: fact.milestone === 'sets' ? 'career sets' : 'club nights' };
    case 'turnout':
      return { value: String(fact.entrants), label: fact.isRecord ? 'entrants — a record' : 'entrants' };
    case 'grand_finals':
      return fact.score
        ? { value: fact.score, label: fact.bracketReset ? 'after a bracket reset' : 'in the decider' }
        : null;
    case 'podium':
      return null;
  }
}

/** Faces for a fact, at a size that reads: the lead gets big heads. */
function FactFaces({ players, size }: { players: RecapPlayer[]; size: 'sm' | 'lg' }) {
  if (players.length === 0) return null;
  return (
    <div className="fact-players">
      {players.map((player, index) => (
        <span className="fact-player" key={`${player.playerId ?? player.name}-${index}`}>
          {player.characters.length > 0 && <CharacterIcons slugs={[...player.characters]} size={size} />}
          <PlayerName player={player} />
        </span>
      ))}
    </div>
  );
}

/**
 * The night's most notable fact, front-page treatment: headline at display
 * scale with the story's one number set beside it.
 */
function LeadStory({
  entry,
  bracket,
  multiBracket,
}: {
  entry: RecapFactEntry;
  bracket: string | null | undefined;
  multiBracket: boolean;
}) {
  const { fact, headline, detail } = entry;
  const stat = statOf(fact);
  return (
    <article className={`lead-story fact-${fact.kind}`}>
      <div className="lead-story-main">
        <p className="fact-kind">
          {KIND_LABELS[fact.kind]}
          {multiBracket && bracket && <span className="fact-kind-bracket"> · {bracket}</span>}
        </p>
        <p className="lead-story-headline">{headline}</p>
        {detail && <p className="lead-story-detail">{detail}</p>}
        <FactFaces players={playersOf(fact)} size="lg" />
      </div>
      {stat && (
        <div className="lead-story-stat">
          <span className="lead-story-stat-value num">{stat.value}</span>
          <span className="lead-story-stat-label">{stat.label}</span>
        </div>
      )}
    </article>
  );
}

/**
 * One fact. The copy is written server-side by the engine's formatter, so the
 * page, the share image and anything else built on recaps describe a night the
 * same way; the card adds the number, the faces and the links.
 */
function FactCard({
  entry,
  bracket,
  multiBracket,
}: {
  entry: RecapFactEntry;
  bracket: string | null | undefined;
  multiBracket: boolean;
}) {
  const { fact, headline, detail } = entry;
  const stat = statOf(fact);

  return (
    <li className={`fact-card fact-${fact.kind}`}>
      <div className="fact-top">
        <p className="fact-kind">{KIND_LABELS[fact.kind]}</p>
        {stat && (
          <p className="fact-stat" title={stat.label}>
            <span className="fact-stat-value num">{stat.value}</span>
            <span className="fact-stat-label">{stat.label}</span>
          </p>
        )}
      </div>
      <p className="fact-headline">{headline}</p>
      {detail && <p className="fact-detail">{detail}</p>}
      <FactFaces players={playersOf(fact)} size="sm" />
      {/* Only worth saying which bracket when the night had more than one. */}
      {multiBracket && bracket && <p className="fact-bracket">{bracket}</p>}
    </li>
  );
}

function PlayerName({ player }: { player: RecapPlayer }) {
  const label = (
    <>
      {player.name}
      {player.companyCode && <span className="fact-company"> {player.companyCode}</span>}
    </>
  );
  if (!player.playerId) return <span className="fact-name">{label}</span>;
  return (
    <Link className="fact-name" to="/players/$playerId" params={{ playerId: player.playerId }}>
      {label}
    </Link>
  );
}

/** Every player a fact refers to, for the faces strip. */
function playersOf(fact: RecapFact): RecapPlayer[] {
  switch (fact.kind) {
    case 'podium':
      return fact.places.map((place) => place.player);
    case 'seed_upset':
    case 'rating_upset':
    case 'nailbiter':
    case 'grand_finals':
      return [fact.winner, fact.loser];
    case 'rivalry':
      return [fact.a, fact.b];
    case 'breakthrough':
      return [fact.winner, fact.loser];
    case 'debut':
      return fact.players;
    case 'losers_run':
    case 'overperformer':
    case 'clean_sweep':
    case 'biggest_climb':
    case 'mover':
    case 'milestone':
      return [fact.player];
    case 'turnout':
      return [];
  }
}

const KIND_LABELS: Record<RecapFact['kind'], string> = {
  podium: 'Podium',
  seed_upset: 'Upset',
  rating_upset: 'Upset',
  losers_run: 'The comeback',
  overperformer: 'Overperformer',
  nailbiter: 'Nailbiter',
  clean_sweep: 'Clean sweep',
  biggest_climb: 'Player of the night',
  mover: 'On the board',
  rivalry: 'Rivalry',
  breakthrough: 'Breakthrough',
  debut: 'New blood',
  milestone: 'Milestone',
  turnout: 'Turnout',
  grand_finals: 'The final',
};

/** Copy a link, or save the night as an image. */
function ShareBar({
  data,
  headline,
  podium,
}: {
  data: RecapData;
  headline: string;
  podium: Extract<RecapFact, { kind: 'podium' }> | null;
}) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'rendering' | 'failed'>('idle');

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setStatus('copied');
      setTimeout(() => setStatus('idle'), 2000);
    } catch {
      setStatus('failed');
    }
  };

  const saveImage = async () => {
    setStatus('rendering');
    try {
      const blob = await renderShareCard({
        title: headline,
        date: formatDate(data.tournaments[0]?.eventDate ?? null),
        podium:
          podium?.places.map((place) => ({
            place: place.place,
            name: place.player.name,
            companyCode: place.player.companyCode,
          })) ?? [],
        facts: data.facts
          .filter((entry) => entry.fact.kind !== 'podium')
          .slice(0, 4)
          .map((entry) => entry.headline),
        entrants: data.entrants,
        setsPlayed: data.setsPlayed,
      });
      if (!blob) {
        setStatus('failed');
        return;
      }
      downloadBlob(blob, `${data.slug}-recap.png`);
      setStatus('idle');
    } catch {
      setStatus('failed');
    }
  };

  return (
    <div className="recap-share">
      <button type="button" className="btn btn-small" onClick={() => void copyLink()}>
        {status === 'copied' ? 'Link copied' : 'Copy link'}
      </button>
      <button
        type="button"
        className="btn btn-small"
        onClick={() => void saveImage()}
        disabled={status === 'rendering'}
      >
        {status === 'rendering' ? 'Rendering…' : 'Save image'}
      </button>
      {status === 'failed' && <span className="error-text">Could not share — try again.</span>}
    </div>
  );
}
