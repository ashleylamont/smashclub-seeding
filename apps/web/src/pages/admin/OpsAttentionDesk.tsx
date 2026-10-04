import { Disclosure } from '../../components/ui/Disclosure';
import { Button } from '../../components/ui/Button';
import { opsAttention } from '../../lib/opsAttention';
import type { trpc } from '../../lib/trpc';
import './OpsAttentionDesk.css';

type Overview = Awaited<ReturnType<typeof trpc.eventOps.overview.query>>;
export function OpsAttentionDesk({
  data,
  onMatch,
  onJump,
}: {
  data: Overview;
  onMatch: (matchId: string) => void;
  onJump: (id: string) => void;
}) {
  const { reports, decisions, dispatch, needsStations } = opsAttention(data);
  const stale = reports.filter((report) => report.stale).length;
  const count = reports.length + decisions.length + (needsStations ? 1 : 0);
  if (['complete', 'cancelled'].includes(data.plan.status)) return null;
  return (
    <section className="card ops-attention" aria-labelledby="ops-attention-title">
      <div className="ops-attention-heading">
        <div>
          <h3 id="ops-attention-title">
            Needs attention <span className="chip">{count}</span>
          </h3>
          <p className="muted">
            {count ? 'Review pending decisions below.' : 'No decisions pending.'}
          </p>
        </div>
      </div>
      <div className="ops-attention-groups">
        {reports.length > 0 && (
          <Disclosure
            title={
              <>
                Score reviews · {reports.length}
                {stale > 0 ? ` (${stale} changed since submission)` : ''}
              </>
            }
            className="ops-attention-group"
          >
            <ul>
              {reports.map((report) => (
                <li key={report.id}>
                  <div>
                    <strong>
                      {report.match?.player1Name ?? 'Player'} {report.score1}–{report.score2}{' '}
                      {report.match?.player2Name ?? 'Player'}
                    </strong>
                    <span>
                      {report.match?.label ?? 'Match unavailable'} ·{' '}
                      {report.stale
                        ? 'Match changed — check the current result before rejecting or correcting.'
                        : 'Awaiting TO approval'}
                    </span>
                  </div>
                  <Button
                    size="small"
                    type="submit"
                    onClick={() => onJump(`score-report-${report.id}`)}
                  >
                    Review score
                  </Button>
                </li>
              ))}
            </ul>
          </Disclosure>
        )}
        {decisions.length > 0 && (
          <Disclosure
            title={<> Match decisions · {decisions.length} </>}
            className="ops-attention-group"
          >
            <ul>
              {decisions.map((match) => (
                <li key={match.id}>
                  <div>
                    <strong>
                      {match.player1Name || 'Awaiting player'} vs{' '}
                      {match.player2Name || 'Awaiting player'}
                    </strong>
                    <span>
                      {match.label} · {match.blockedReason ?? 'An organiser has held this match.'}
                    </span>
                  </div>
                  <Button size="small" type="submit" onClick={() => onMatch(match.id)}>
                    Open match
                  </Button>
                </li>
              ))}
            </ul>
          </Disclosure>
        )}
        {needsStations && (
          <div className="ops-attention-setup">
            <p>
              <strong>No stations configured</strong>
              <br />
              <span className="muted">
                Add your setups so players and TOs can see where matches should be played.
              </span>
            </p>
            <Button size="small" type="submit" onClick={() => onJump('station-controls')}>
              Set up stations
            </Button>
          </div>
        )}
      </div>
      {dispatch.length > 0 && (
        <Disclosure
          title={
            <>
              Ready to dispatch · {dispatch.length} free{' '}
              {dispatch.length === 1 ? 'station' : 'stations'}
            </>
          }
          className="ops-attention-dispatch"
        >
          <p className="muted">
            These stations have a next pairing. Self-running pools can start it themselves; use
            station controls if they need a hand.
          </p>
          <ul>
            {dispatch.map(({ station, match }) => (
              <li key={station.id}>
                <div>
                  <strong>{station.name}</strong>
                  <span>
                    {match.player1Name} vs {match.player2Name} · {match.label}
                  </span>
                </div>
                <Button size="small" type="submit" onClick={() => onJump('station-controls')}>
                  Station controls
                </Button>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
    </section>
  );
}
