import { trpc } from '../../lib/trpc';
type Overview = Awaited<ReturnType<typeof trpc.eventOps.overview.query>>;
export function ScorePolicyControls({ data, admin, disabled, act }: { data: Overview; admin: boolean; disabled: boolean; act: (work: () => Promise<unknown>, message?: string) => Promise<void> }) {
  const mode = data.settings.scoreReportingMode ?? 'to_review';
  const disputes = data.reports.filter(report => report.status === 'pending' && report.isDispute);
  return <section className="card" aria-labelledby="score-policy-heading"><h3 id="score-policy-heading">Score approval</h3>
    {admin ? <label>Event score policy<select className="select" value={mode} disabled={disabled || data.plan.bracketMode !== 'native'} onChange={event => void act(() => trpc.eventOps.settings.mutate({ planId: data.plan.id, published: data.settings.published, playerReports: data.settings.playerReports, scoreReportingMode: event.target.value as 'to_review' | 'approve_unless_disputed' }), 'Score approval policy updated')}><option value="to_review">TO approval / existing pool settings</option><option value="approve_unless_disputed">Approve unless disputed</option></select></label> : <p>{mode === 'approve_unless_disputed' ? 'Approve unless disputed' : 'TO approval / existing pool settings'}</p>}
    <p className="muted">{mode === 'approve_unless_disputed' ? 'The first played score advances the match immediately. Matching reports confirm it; different scores are flagged for TO review. The recorded result stays in place until a TO resolves the disagreement.' : 'Player reports need TO approval unless immediate acceptance is enabled for their self-running pool.'}</p>
    {data.plan.bracketMode !== 'native' && <p className="muted">Event-wide automatic approval is available for native Nemesis events.</p>}
    <p className="muted">Guests and signed-in players follow the same policy. Byes, forfeits and corrections remain TO decisions. Resolve disputes before finalising the event; downstream play can prevent changing a winner.</p>
    {disputes.length > 0 && <p role="status"><strong>{disputes.length} conflicting {disputes.length === 1 ? 'report needs' : 'reports need'} review.</strong> <a href="#score-submissions">Review score submissions →</a></p>}
  </section>;
}
