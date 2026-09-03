import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { trpc } from '../lib/trpc';
import type { EventOverviewData } from '../lib/apiTypes';
import { formatDate } from '../lib/format';
import './EventPage.css';


export function EventPage() {
  const { slug } = useParams({ from: '/events/$slug' });
  const query = useQuery({ queryKey: ['eventOverview', slug], queryFn: () => trpc.public.eventOverview.query({ slug }) });
  if (query.isPending) return <p className="loading-text">Loading event…</p>;
  if (query.isError) return <p className="error-text">Failed to load event: {query.error.message}</p>;
  if (!query.data) return <p className="error-text">Event not found.</p>;
  return <EventOverview data={query.data} />;
}

function EventOverview({ data }: { data: EventOverviewData }) {
  return (
    <div>
      <div className="page-header event-header">
        <div><h1>{data.name}</h1><p className="muted">{formatDate(data.date)} · {data.brackets.length} {data.brackets.length === 1 ? 'bracket' : 'brackets'}</p></div>
        <div className="event-header-links"><Link to="/recaps/$slug" params={{ slug: data.canonicalSlug }}>Recap →</Link></div>
      </div>
      {data.warnings?.map((warning) => <div className="banner banner-warning" key={warning}>{warning}</div>)}
      {data.divisions.length > 0 && data.brackets.some((b) => b.roleSource === 'unclassified') && (
        <div className="banner banner-warning">Some brackets could not be classified as Upper/Lower or Main/Consolation; their standalone results are shown below.</div>
      )}
      {data.divisions.filter((division) => division.players.length > 0).map((division) => (
        <section className="section" key={division.division}>
          <h2>{division.division === 'upper' ? 'Upper' : 'Lower'} standings</h2>
          <p className="muted">Finishing places are within this division. Ties and missing placements remain visible. W-L excludes byes and setup results.</p>
          {division.notice && <p className="banner banner-warning">{division.notice}</p>}
          <Standings players={division.players} />
        </section>
      ))}
      <section className="section">
        <h2>Brackets</h2>
        <div className="event-bracket-grid">
          {data.brackets.map((bracket) => (
            <article className="card event-bracket-card" key={bracket.tournamentId}>
              <div className="page-header"><h3><Link to="/tournaments/$slug" params={{ slug: bracket.slug }}>{bracket.name}</Link></h3><span className="chip">{bracket.division && bracket.stage ? `${bracket.division} ${bracket.stage}` : 'Standalone bracket'}</span></div>
              {bracket.roleSource === 'unclassified' ? <Standings players={bracket.players} /> : <details><summary>View bracket standings</summary><Standings players={bracket.players} /></details>}
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function Standings({ players }: { players: EventOverviewData['divisions'][number]['players'] }) {
  return <div className="table-scroll"><table className="data-table event-standings"><thead><tr><th>Place</th><th>Player</th><th>W-L</th><th>Note</th></tr></thead><tbody>{players.map((p, index) => <tr key={p.entryKey ?? `${p.tournamentId}-${p.playerId ?? index}`}><td className="num">{p.place ?? '—'}</td><td>{p.playerId ? <Link to="/players/$playerId" params={{ playerId: p.playerId }}>{p.name}</Link> : p.name}</td><td className="num">{p.wins}-{p.losses}</td><td className="muted">{p.provisional ? 'Placement unavailable' : p.placeSource === 'derived' ? 'Bracket-derived place' : p.placeSource === 'reported' ? 'Reported place' : ''}</td></tr>)}</tbody></table></div>;
}
