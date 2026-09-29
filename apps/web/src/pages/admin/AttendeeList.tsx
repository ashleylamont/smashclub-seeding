import { Fragment, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { trpc } from '../../lib/trpc';

type Roster = Awaited<ReturnType<typeof trpc.eventOps.attendeeRoster.query>>;
type Attendee = Roster['attendees'][number];

export function AttendeeList({ planId, closed }: { planId: string; closed: boolean }) {
  const roster = useQuery({
    queryKey: ['eventOps', 'attendeeRoster', planId],
    queryFn: () => trpc.eventOps.attendeeRoster.query({ planId }),
    refetchInterval: 5000,
  });
  const [division, setDivision] = useState('all');
  const [company, setCompany] = useState('all');
  const [nameStyle, setNameStyle] = useState<'alias' | 'full'>('alias');
  const [copyMessage, setCopyMessage] = useState('');
  const copyArea = useRef<HTMLTextAreaElement>(null);
  const filtered = (roster.data?.attendees ?? [])
    .filter(
      (row) =>
        (division === 'all' ||
          (division === 'unassigned' ? row.division === null : row.division === division)) &&
        (company === 'all' || (row.companyCode ?? '') === company),
    )
    .sort((a, b) =>
      (nameStyle === 'alias' ? a.publicAlias : a.canonicalName).localeCompare(
        nameStyle === 'alias' ? b.publicAlias : b.canonicalName,
      ),
    );
  const names = filtered
    .map((row) => (nameStyle === 'alias' ? row.publicAlias : row.canonicalName))
    .join('\n');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(names);
      setCopyMessage(`Copied ${filtered.length} ${filtered.length === 1 ? 'name' : 'names'}.`);
    } catch {
      copyArea.current?.select();
      setCopyMessage('Select and copy the names from the box.');
    }
  };

  return (
    <section className="card ops-attendee-list" id="attendee-list">
      <h3>Attending players</h3>
      <p className="muted">
        Current roster, excluding withdrawals. The roster entry is the original text supplied for
        matching; edits change the player registry and do not rewrite that entry.
      </p>
      {roster.isPending && <p>Loading attendees…</p>}
      {roster.isError && <p role="alert">{roster.error.message}</p>}
      {roster.data && (
        <>
          <div className="ops-attendee-filters">
            <label>
              Names to copy
              <select
                className="select"
                value={nameStyle}
                onChange={(event) => {
                  setNameStyle(event.target.value as typeof nameStyle);
                  setCopyMessage('');
                }}
              >
                <option value="alias">Public aliases</option>
                <option value="full">Full names</option>
              </select>
            </label>
            <label>
              Division
              <select
                className="select"
                value={division}
                onChange={(e) => {
                  setDivision(e.target.value);
                  setCopyMessage('');
                }}
              >
                <option value="all">All divisions</option>
                <option value="upper">Upper</option>
                <option value="lower">Lower</option>
                <option value="unassigned">Unassigned</option>
              </select>
            </label>
            <label>
              Company
              <select
                className="select"
                value={company}
                onChange={(e) => {
                  setCompany(e.target.value);
                  setCopyMessage('');
                }}
              >
                <option value="all">All companies</option>
                <option value="">No company</option>
                {roster.data.companies.map((option) => (
                  <option key={option.code} value={option.code}>
                    {option.name} ({option.code})
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="muted">
            {filtered.length} of {roster.data.attendees.length} attending players
          </p>
          <div className="ops-attendee-copy">
            <textarea
              ref={copyArea}
              className="input"
              aria-label="Names ready to copy"
              readOnly
              rows={Math.min(Math.max(filtered.length, 3), 8)}
              value={names}
              onFocus={(event) => event.currentTarget.select()}
            />
            <button
              className="btn btn-primary"
              type="button"
              disabled={!filtered.length}
              onClick={() => void copy()}
            >
              Copy names
            </button>
          </div>
          {copyMessage && <p role="status">{copyMessage}</p>}
          {filtered.length === 0 && (
            <p className="muted">No attending players match these filters.</p>
          )}
          {filtered.length > 0 && (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Public alias</th>
                    <th>Full name</th>
                    <th>Original roster entry</th>
                    <th>Division</th>
                    <th>Company</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((row) => (
                    <AttendeeRow
                      key={row.entryId}
                      planId={planId}
                      row={row}
                      companies={roster.data!.companies}
                      closed={closed}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function AttendeeRow({
  planId,
  row,
  companies,
  closed,
}: {
  planId: string;
  row: Attendee;
  companies: Roster['companies'];
  closed: boolean;
}) {
  const cache = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [canonicalName, setCanonicalName] = useState(row.canonicalName);
  const [displayName, setDisplayName] = useState(row.displayName ?? '');
  const [companyCode, setCompanyCode] = useState(row.companyCode ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await trpc.eventOps.updateAttendee.mutate({
        planId,
        playerId: row.playerId,
        canonicalName: canonicalName.trim(),
        displayName: displayName.trim() || null,
        companyCode: companyCode || null,
      });
      setEditing(false);
      await Promise.all([
        cache.invalidateQueries({ queryKey: ['eventOps', 'attendeeRoster', planId] }),
        cache.invalidateQueries({ queryKey: ['eventOps', planId], exact: true }),
        cache.invalidateQueries({ queryKey: ['admin', 'players'] }),
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update player.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Fragment>
      <tr>
        <td>{row.publicAlias}</td>
        <td>{row.canonicalName}</td>
        <td>{row.rawInput}</td>
        <td>{row.division ?? 'Unassigned'}</td>
        <td>{row.companyName ?? '—'}</td>
        <td>
          <button
            className="btn btn-small"
            type="button"
            disabled={closed}
            aria-label={`Edit ${row.canonicalName}`}
            onClick={() => {
              setCanonicalName(row.canonicalName);
              setDisplayName(row.displayName ?? '');
              setCompanyCode(row.companyCode ?? '');
              setError('');
              setEditing(!editing);
            }}
          >
            {editing ? 'Close' : 'Edit'}
          </button>
        </td>
      </tr>
      {editing && (
        <tr>
          <td colSpan={6}>
            <form
              className="ops-attendee-edit"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <label>
                Full name
                <input
                  className="input"
                  required
                  maxLength={120}
                  value={canonicalName}
                  onChange={(e) => setCanonicalName(e.target.value)}
                />
              </label>
              <label>
                Public alias
                <input
                  className="input"
                  maxLength={80}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Use name-derived alias"
                />
              </label>
              <label>
                Company
                <select
                  className="select"
                  value={companyCode}
                  onChange={(e) => setCompanyCode(e.target.value)}
                >
                  <option value="">No company</option>
                  {companies.map((option) => (
                    <option key={option.code} value={option.code}>
                      {option.name} ({option.code})
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="btn btn-primary"
                type="submit"
                disabled={busy || !canonicalName.trim() || closed}
              >
                {busy ? 'Saving…' : 'Save player'}
              </button>
              <button
                className="btn"
                type="button"
                disabled={busy}
                onClick={() => setEditing(false)}
              >
                Cancel
              </button>
              {error && (
                <p className="error-text" role="alert">
                  {error}
                </p>
              )}
            </form>
          </td>
        </tr>
      )}
    </Fragment>
  );
}
