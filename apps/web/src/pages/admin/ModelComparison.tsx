import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { trpc } from '../../lib/trpc';

/**
 * Side-by-side of what each rating model would publish.
 *
 * Fitted on demand rather than on page load: it re-runs both models over the
 * whole history, which is cheap at club scale but not free, and an admin only
 * wants it when they are actually considering a switch.
 */
export function ModelComparison({ activeModel }: { activeModel: string }) {
  const [enabled, setEnabled] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const comparison = useQuery({
    queryKey: ['admin', 'compareModels'],
    queryFn: () => trpc.admin.compareModels.query(),
    enabled,
    staleTime: 5 * 60 * 1000,
  });

  return (
    <section className="section model-comparison">
      <h3>Compare models</h3>
      <p className="muted">
        Fits Glicko-2 and WHR over the same history and shows where they disagree. Read-only — nothing is
        published until the active model is saved above.
      </p>

      {!enabled && (
        <button type="button" className="btn" onClick={() => setEnabled(true)}>
          Run comparison
        </button>
      )}

      {enabled && comparison.isPending && <p className="loading-text">Fitting both models…</p>}
      {comparison.isError && <p className="error-text">{comparison.error.message}</p>}

      {comparison.data && (
        <>
          <dl className="comparison-stats">
            <div className="stat">
              <dt>Ranked players</dt>
              <dd className="num">{comparison.data.players}</dd>
            </div>
            <div className="stat">
              <dt>Median rank move</dt>
              <dd className="num">{comparison.data.medianAbsRankDelta}</dd>
            </div>
            <div className="stat">
              <dt>Moves &gt; 10 places</dt>
              <dd className="num">{comparison.data.bigMovers}</dd>
            </div>
            <div className="stat">
              <dt>Top-10 shared</dt>
              <dd className="num">{comparison.data.topTenOverlap}/10</dd>
            </div>
          </dl>

          {!comparison.data.whrConverged && (
            <p className="banner banner-warning">
              The WHR fit did not converge in {comparison.data.whrIterations} iterations — treat its numbers as
              provisional.
            </p>
          )}

          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Player</th>
                  <th className="num">Sets</th>
                  <th className="num">Glicko-2 #</th>
                  <th className="num">Rating</th>
                  <th className="num">WHR #</th>
                  <th className="num">Rating</th>
                  <th className="num">Move</th>
                </tr>
              </thead>
              <tbody>
                {(showAll ? comparison.data.rows : comparison.data.rows.slice(0, 25)).map((row) => (
                  <tr key={row.playerId}>
                    <td>
                      <Link to="/players/$playerId" params={{ playerId: row.playerId }}>
                        {row.name}
                      </Link>
                      {row.companyCode && <span className="muted"> {row.companyCode}</span>}
                    </td>
                    <td className="num">{row.matchCount}</td>
                    <td className="num">{row.glicko ? `#${row.glicko.rank}` : '—'}</td>
                    <td className="num">
                      {row.glicko ? `${row.glicko.skillRating.toFixed(0)} ±${row.glicko.skillSd.toFixed(0)}` : '—'}
                    </td>
                    <td className="num">{row.whr ? `#${row.whr.rank}` : '—'}</td>
                    <td className="num">
                      {row.whr ? `${row.whr.skillRating.toFixed(0)} ±${row.whr.skillSd.toFixed(0)}` : '—'}
                    </td>
                    <td className={`num ${(row.rankDelta ?? 0) > 0 ? 'seed-up' : (row.rankDelta ?? 0) < 0 ? 'seed-down' : ''}`}>
                      {row.rankDelta === null
                        ? '—'
                        : row.rankDelta === 0
                          ? '='
                          : row.rankDelta > 0
                            ? `↑${row.rankDelta}`
                            : `↓${Math.abs(row.rankDelta)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {comparison.data.rows.length > 25 && (
            <button type="button" className="btn btn-small" onClick={() => setShowAll((prev) => !prev)}>
              {showAll ? 'Show biggest 25 only' : `Show all ${comparison.data.rows.length}`}
            </button>
          )}
          <p className="muted comparison-note">
            Rows are ordered by biggest disagreement. &ldquo;Move&rdquo; is places gained going from Glicko-2 to
            WHR. Currently publishing <code>{activeModel}</code>.
          </p>
        </>
      )}
    </section>
  );
}
