import { Button } from '../../components/ui/Button';
import type { poolStandings } from '../../lib/eventQueue';
import { poolTitle } from '../../lib/poolFlow';
import type { trpc } from '../../lib/trpc';

type Overview = Awaited<ReturnType<typeof trpc.eventOps.overview.query>>;
type PoolOrder = NonNullable<
  Awaited<ReturnType<typeof trpc.eventOps.snapshot.query>>['poolOrders']
>[number];

const confirmed = new Set<PoolOrder['status']>([
  'automatic',
  'manual',
  'retained_after_correction',
]);

function orderSummary(order: PoolOrder, closed: boolean) {
  if (order.status === 'review_pending')
    return closed ? 'Score review was pending when the event closed.' : 'Score review pending.';
  if (closed && !confirmed.has(order.status)) return 'Finishing order remained unresolved.';
  if (order.plannerConfirmation?.available === false) return order.plannerConfirmation.reason;
  return order.reason;
}

export function OpsPoolStandings({
  pools,
  data,
  admin,
  closed,
  onReviewScores,
}: {
  pools: ReturnType<typeof poolStandings>;
  data: Overview;
  admin: boolean;
  closed: boolean;
  onReviewScores: () => void;
}) {
  const byPool = new Map<string, PoolOrder>(
    ('poolOrders' in data ? data.poolOrders : undefined)?.map(
      (order) => [`${order.division}:${order.poolIndex}`, order] as const,
    ),
  );
  const rows = pools.map((pool) => {
    const key = `${pool.division}:${pool.poolIndex}`;
    return { pool, key, order: byPool.get(key) };
  });
  const hasStatuses = rows.some(({ order }) => order);
  const missingStatus = rows.some(({ order }) => !order);
  const needsConfirmation =
    !closed && rows.some(({ order }) => order?.plannerConfirmation?.available);
  const needsReview = !closed && rows.some(({ order }) => order?.status === 'review_pending');
  return (
    <section className="card" aria-labelledby="ops-pool-standings-title">
      <h3 id="ops-pool-standings-title">Pool standings</h3>
      <p className="muted">
        {closed ? 'Results' : 'Live results'} are sorted by set wins, then game difference.
        Confirmed finishing orders are recorded separately.
      </p>
      {missingStatus && (
        <p className="muted">
          {data.plan.bracketMode === 'challonge'
            ? 'Use the linked bracket or the organiser’s recorded order for official places.'
            : 'Use the event’s recorded finishing order for official places.'}
        </p>
      )}
      <div className="ops-bottom-grid">
        {rows.map(({ pool, key, order }) => {
          const title = poolTitle(key, data.plan.structure, 'heading');
          return (
            <section key={key} aria-label={title}>
              <h4>
                {title}{' '}
                <span className="muted">
                  {pool.complete}/{pool.total} sets
                </span>
              </h4>
              {order ? (
                <p className="muted">{orderSummary(order, closed)}</p>
              ) : (
                hasStatuses && <p className="muted">Finishing order status unavailable.</p>
              )}
              <table className="ops-standings">
                <thead>
                  <tr>
                    <th>Player</th>
                    <th>W–L</th>
                    <th>Games ±</th>
                    <th>To play</th>
                  </tr>
                </thead>
                <tbody>
                  {pool.players.map((player) => (
                    <tr key={player.id}>
                      <td>{player.name}</td>
                      <td>
                        {player.wins}–{player.losses}
                      </td>
                      <td>
                        {player.differential > 0 ? '+' : ''}
                        {player.differential}
                      </td>
                      <td>{player.remaining}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          );
        })}
      </div>
      {(needsReview || needsConfirmation) && (
        <div className="ui-actions">
          {needsReview && (
            <Button size="small" onClick={onReviewScores}>
              Review score submissions
            </Button>
          )}
          {needsConfirmation &&
            (admin ? (
              <Button asChild size="small">
                <a href={`/admin/event-planner?plan=${data.plan.id}&step=pools`}>
                  Confirm pool orders in planner
                </a>
              </Button>
            ) : (
              <p className="muted">
                Ask an event administrator to confirm the outstanding pool orders.
              </p>
            ))}
        </div>
      )}
    </section>
  );
}
