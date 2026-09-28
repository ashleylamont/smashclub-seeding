import { Fragment } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { eventNameOf } from '@smashclub/shared';
import { trpc } from '../../lib/trpc';
import { breakthroughDefaults, summariseBreakthrough, type BreakthroughData, type BreakthroughOptions } from '../../lib/breakthrough';
import './Breakthrough.css';

const signed = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(2)}`;
const percent = (n: number | null) => n === null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(1)} pp`;
const dateTime = (value: string | null) => value ? new Date(value).toLocaleString() : 'Never synced';

export function AdminBreakthroughPage() {
  const options = useSearch({ from: '/admin/breakthroughs' });
  const navigate = useNavigate({ from: '/admin/breakthroughs' });
  const change = (patch: Partial<BreakthroughOptions>) => void navigate({ search: { ...options, ...patch }, replace: true });
  const tournaments = useQuery({ queryKey: ['tournaments'], queryFn: () => trpc.public.tournaments.query(), refetchInterval: 15_000 });
  const grouped = new Map<string, string[]>();
  for (const t of tournaments.data ?? []) {
    if (!t.eventDate) continue;
    const key = t.eventDate.slice(0, 10);
    grouped.set(key, [...(grouped.get(key) ?? []), t.name]);
  }
  const nights = [...grouped].sort(([a], [b]) => b.localeCompare(a));
  const event = options.event || nights[0]?.[0] || '';
  const query = useQuery({
    queryKey: ['admin', 'breakthrough', event], queryFn: () => trpc.admin.breakthrough.query({ eventKey: event }),
    enabled: Boolean(event), refetchInterval: 15_000,
  });
  const controls: Array<{ key: keyof typeof breakthroughDefaults; label: string; max: number }> = [
    { key: 'priorNights', label: 'Minimum prior nights', max: 20 },
    { key: 'priorSets', label: 'Minimum prior sets', max: 100 },
    { key: 'nightSets', label: 'Comparable sets tonight', max: 30 },
    { key: 'opponents', label: 'Different opponents tonight', max: 30 },
    { key: 'smoothing', label: 'Small-sample adjustment', max: 20 },
  ];
  return <div className="breakthrough-page">
    <section className="card section">
      <p className="muted">TO decision support</p>
      <h2>Breakthroughs</h2>
      <p>Who is playing above their usual level? Compare the evidence, adjust the criteria, and make the call.</p>
      <div className="breakthrough-toolbar">
        <label>Club night<select className="select" value={event} onChange={(e) => change({ event: e.target.value })}>
          {!nights.length && <option value="">No dated events yet</option>}
          {options.event && !grouped.has(options.event) && <option value={options.event}>{options.event}</option>}
          {nights.map(([key, names]) => <option key={key} value={key}>{key} · {eventNameOf(names)}</option>)}
        </select></label>
        <button className="btn" disabled={!event || query.isFetching} onClick={() => void query.refetch()}>
          {query.isFetching ? 'Checking…' : 'Refresh results'}
        </button>
      </div>
      {tournaments.isError && <p className="error-text">Could not load events: {tournaments.error.message}</p>}
      <div className="breakthrough-controls">
        {controls.map(({ key, label, max }) => <label key={key}>{label}
          <input className="input" type="number" min={0} max={max} step={1} value={options[key]}
            onChange={(e) => { const value = e.target.valueAsNumber; if (Number.isInteger(value) && value >= 0 && value <= max) change({ [key]: value, event }); }} />
        </label>)}
      </div>
      <p className="muted">Criteria flag players with enough history and comparable results. A comparable set needs prior history for both players.
        The adjustment adds neutral sets to soften small samples; 0 switches it off. These are judgement aids, not validated award thresholds.</p>
      <div className="breakthrough-toolbar">
        <label>Order by<select className="select" value={options.sort} onChange={(e) => change({ sort: e.target.value as BreakthroughOptions['sort'], event })}>
          <option value="adjusted">Adjusted surplus per set</option><option value="surplus">Total wins above expected</option>
        </select></label>
        <label className="checkbox-label"><input type="checkbox" checked={options.showAll} onChange={(e) => change({ showAll: e.target.checked, event })} />Show players below criteria</label>
        <button className="btn" onClick={() => change({ ...breakthroughDefaults, showAll: true, sort: 'adjusted', event })}>Reset criteria</button>
      </div>
    </section>
    {event && query.isPending && <p className="loading-text">Calculating pre-night expectations…</p>}
    {query.isError && <p className="error-text">Could not refresh analysis: {query.error.message}. Any results below are from the last successful check.</p>}
    {query.data === null && <p className="muted">No event found for that date.</p>}
    {query.data && <Evidence data={query.data} options={options} />}
    <section className="card section">
      <h3>How to read the numbers</h3>
      <p>Expected wins add up the pre-night win chances against the opponents actually faced. Surplus is actual wins minus expected wins,
        using comparable sets only. Tonight’s wins and losses each count as one set, including pools and consolation.</p>
      <p>Adjusted surplus = 100 × surplus ÷ (comparable sets + adjustment), in percentage points (pp).
        It balances extra opportunities from a long run with the volatility of a short one. It is not a probability of improvement or a confidence interval.</p>
      <p>Expectations use only results from earlier nights and account for rating uncertainty. They stay fixed as tonight’s results arrive.
        Historical corrections or changes to rating settings can change the baseline. Attendance penalties and seed positions do not enter the calculation.</p>
      <p className="muted">One night shows performance above expectation, not proof of lasting improvement. Sparse history, repeated opponents and an unfinished draw
        all limit the comparison. Expand a player to see every set and how their score looks without their strongest result.</p>
    </section>
  </div>;
}

function Evidence({ data, options }: { data: BreakthroughData; options: BreakthroughOptions }) {
  const rows = data.rows.map((row) => ({ row, summary: summariseBreakthrough(row, options) }));
  const shown = rows.filter(({ summary }) => options.showAll || summary.meetsCriteria).sort((a, b) => {
    const score = (s: typeof a.summary) => s.assessed ? (options.sort === 'surplus' ? s.surplus : s.adjusted!) : -Infinity;
    return score(b.summary) - score(a.summary) || a.row.name.localeCompare(b.row.name);
  });
  const bracket = new Map(data.brackets.map((b) => [b.id, b]));
  const monitoring = data.brackets.filter((b) => b.liveUntil && Date.parse(b.liveUntil) > Date.parse(data.checkedAt)).length;
  return <section className="card section" aria-label="Breakthrough evidence">
    <div className="breakthrough-status"><h3>{data.name}</h3><strong>{data.complete ? 'Completed night' : 'In progress · provisional'}</strong></div>
    <p className="muted" role="status">{data.coverage.played} played sets · {rows.filter(({ summary }) => summary.meetsCriteria).length} players meet criteria
      {' · '}{data.model === 'whr' ? 'Whole-history rating' : 'Glicko-2'} · Checked {dateTime(data.checkedAt)}. Refreshes every 15 seconds while open.</p>
    {!data.complete && <p className="breakthrough-notice">Results will change as the night continues. Players may have played different numbers of sets.
      {' '}{monitoring === data.brackets.length ? 'All brackets are being monitored.' : `${monitoring}/${data.brackets.length} brackets are being monitored. Start or extend Live in Admin → Tournaments to import new results automatically.`}
      {' '}The analysis updates after those results sync.</p>}
    {!data.converged && <p className="error-text">The pre-night rating fit did not converge. Treat these estimates with caution.</p>}
    {(data.coverage.unlinked > 0 || data.unresolvedEntrants > 0) && <p className="breakthrough-notice">{data.coverage.unlinked} completed sets could not be linked to two distinct players;
      {' '}{data.unresolvedEntrants} bracket entries need identity review.</p>}
    <details className="breakthrough-sources"><summary>Data coverage and sync times</summary>
      <p>{data.coverage.pending} pending sets · {data.coverage.excluded} excluded sets (byes, forfeits, ignored stages or manual exclusions). Rating settings version {data.settingsVersion}.</p>
      <ul>{data.brackets.map((b) => <li key={b.id}><Link to="/tournaments/$slug" params={{ slug: b.slug }}>{b.name}</Link>: {dateTime(b.lastSyncedAt)} · {b.syncState}</li>)}</ul>
    </details>
    {!shown.length ? <p className="muted">{rows.length ? 'No players meet these criteria yet. Show players below criteria or lower the thresholds.' : 'No linked, played sets yet. Results will appear here as they sync.'}</p> :
      <div className="breakthrough-table-wrap"><table className="breakthrough-table">
        <caption>Performance above pre-night expectations. Expand a player for the evidence.</caption>
        <thead><tr><th scope="col">Player / evidence</th><th scope="col">Prior history</th><th scope="col">Tonight W–L</th><th scope="col">Comparable wins</th><th scope="col">Expected wins</th><th scope="col">Surplus wins</th><th scope="col">Adjusted surplus</th></tr></thead>
        <tbody>{shown.map(({ row, summary: s }) => <Fragment key={row.playerId}>
          <tr className="breakthrough-summary-row"><th scope="row"><Link to="/players/$playerId" params={{ playerId: row.playerId }}>{row.name}</Link>
            <span className="breakthrough-criteria">{s.meetsCriteria ? 'Meets criteria' : 'Below criteria'}</span></th>
            <td data-label="Prior history">{row.priorNights} nights<br />{row.priorSets} sets</td><td data-label="Tonight W–L">{s.wins}–{s.losses}</td>
            <td data-label="Comparable wins">{s.assessedWins} / {s.assessed}</td><td data-label="Expected wins">{s.assessed ? s.expected.toFixed(2) : '—'}</td>
            <td data-label="Surplus wins">{s.assessed ? signed(s.surplus) : '—'}</td><td data-label="Adjusted surplus" className="breakthrough-score">{percent(s.adjusted)}</td></tr>
          <tr className="breakthrough-detail-row"><td colSpan={7} className="breakthrough-detail"><details><summary>Set evidence for {row.name}{!s.meetsCriteria && ` · ${s.reasons.join(' · ')}`}</summary>
            <p>Pre-night skill: {row.baseline ? `${Math.round(row.baseline.rating)} ± ${Math.round(row.baseline.sd)} (one standard deviation)` : 'No estimate'}.
              {' '}{s.opponents} different comparable opponents. {s.unassessed} sets without a comparison.
              {' '}{s.thinOpponents} opponents with only one previous night.</p>
            <p>Adjusted surplus without the strongest comparable set: <strong>{percent(s.withoutBest)}</strong>. This is a sensitivity check, not a confidence bound.</p>
            <ul>{row.sets.map((set) => <li key={set.setId}>
              <strong>{set.won ? 'Win' : 'Loss'}</strong> vs {set.opponentName}{set.score ? ` (${set.score})` : ''}
              {' · '}{set.stage === 'group' ? 'Pool' : 'Bracket'} · {bracket.get(set.tournamentId)?.name}
              {' · '}{set.expected === null ? 'No comparison: missing pre-night history' : `${(100 * set.expected).toFixed(0)}% expected win chance; ${signed(Number(set.won) - set.expected)} surplus`}
            </li>)}</ul>
          </details></td></tr>
        </Fragment>)}</tbody>
      </table></div>}
    {data.withoutResults.length > 0 && <details className="breakthrough-sources"><summary>{data.withoutResults.length} entrants without counted results yet</summary>
      <p>{data.withoutResults.map((p) => p.name).join(', ')}</p></details>}
  </section>;
}
