import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { trpc } from '../../lib/trpc';
import type { AdminClaim, AdminCompany, AdminPlayer } from '../../lib/apiTypes';
import { timeAgo } from '../../lib/format';

export function AdminPlayersPage() {
  const queryClient = useQueryClient();
  const players = useQuery({
    queryKey: ['admin', 'players'],
    queryFn: () => trpc.admin.players.query(),
  });
  const companies = useQuery({
    queryKey: ['admin', 'companies'],
    queryFn: () => trpc.admin.companies.query(),
  });

  const [filter, setFilter] = useState('');
  const [mergeSelection, setMergeSelection] = useState<string[]>([]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'players'] });
    void queryClient.invalidateQueries({ queryKey: ['leaderboard'] });
    void queryClient.invalidateQueries({ queryKey: ['player'] });
  };

  const filtered = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const all = players.data ?? [];
    if (!query) return all;
    return all.filter(
      (p) =>
        p.canonicalName.toLowerCase().includes(query) ||
        (p.displayName ?? '').toLowerCase().includes(query) ||
        p.aliases.some((a) => a.includes(query)),
    );
  }, [players.data, filter]);

  const toggleMergeSelection = (playerId: string) => {
    setMergeSelection((prev) =>
      prev.includes(playerId) ? prev.filter((id) => id !== playerId) : [...prev.slice(-1), playerId],
    );
  };

  return (
    <div>
      <ClaimsPanel />

      <div className="section">
        <div className="page-header">
          <h2>Player registry</h2>
          <input
            className="input"
            placeholder="Filter by name or alias…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>

        {mergeSelection.length > 0 && (
          <MergeBar
            selection={mergeSelection}
            players={players.data ?? []}
            onClear={() => setMergeSelection([])}
            onMerged={() => {
              setMergeSelection([]);
              invalidate();
            }}
          />
        )}

        {players.isPending && <p className="loading-text">Loading players…</p>}
        {players.isError && <p className="error-text">{players.error.message}</p>}
        {players.data && (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th title="Select two players to merge">Merge</th>
                  <th>Name</th>
                  <th>Company</th>
                  <th>Aliases</th>
                  <th>Legacy ID</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((player) => (
                  <PlayerRow
                    key={player.id}
                    player={player}
                    companies={companies.data ?? []}
                    mergeSelected={mergeSelection.includes(player.id)}
                    onToggleMerge={() => toggleMergeSelection(player.id)}
                    onChanged={invalidate}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function MergeBar({
  selection,
  players,
  onClear,
  onMerged,
}: {
  selection: string[];
  players: AdminPlayer[];
  onClear: () => void;
  onMerged: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const byId = new Map(players.map((p) => [p.id, p]));
  const [fromId, intoId] = selection;
  const from = fromId ? byId.get(fromId) : undefined;
  const into = intoId ? byId.get(intoId) : undefined;

  const merge = useMutation({
    mutationFn: () => trpc.admin.mergePlayers.mutate({ fromPlayerId: fromId!, intoPlayerId: intoId! }),
    onSuccess: () => {
      setConfirming(false);
      onMerged();
    },
  });

  return (
    <div className="banner banner-warning merge-bar">
      {selection.length === 1 ? (
        <span>
          Merging <strong>{from?.canonicalName}</strong> — now select the player to merge it <em>into</em>.
        </span>
      ) : (
        <span>
          Merge <strong>{from?.canonicalName}</strong> into <strong>{into?.canonicalName}</strong>?
        </span>
      )}
      {selection.length === 2 && (
        <button type="button" className="btn btn-small btn-primary" onClick={() => setConfirming(true)}>
          Merge…
        </button>
      )}
      <button type="button" className="btn btn-small" onClick={onClear}>
        Cancel
      </button>
      {merge.isError && <span className="error-text">{merge.error.message}</span>}

      {confirming && from && into && (
        <div className="modal-overlay" onClick={() => setConfirming(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Merge players</h3>
            <p>
              <strong>{from.canonicalName}</strong> will be merged into <strong>{into.canonicalName}</strong>. All of{' '}
              {from.canonicalName}'s aliases, sets, and history move to {into.canonicalName}; this triggers a full
              recompute. This cannot be undone from the UI.
            </p>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={merge.isPending}
                onClick={() => merge.mutate()}
              >
                {merge.isPending ? 'Merging…' : 'Merge players'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PlayerRow({
  player,
  companies,
  mergeSelected,
  onToggleMerge,
  onChanged,
}: {
  player: AdminPlayer;
  companies: AdminCompany[];
  mergeSelected: boolean;
  onToggleMerge: () => void;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(player.canonicalName);
  const [companyCode, setCompanyCode] = useState(player.companyCode ?? '');
  const [aliasInput, setAliasInput] = useState('');

  const update = useMutation({
    mutationFn: () =>
      trpc.admin.updatePlayer.mutate({
        playerId: player.id,
        canonicalName: name.trim(),
        companyCode: companyCode === '' ? null : companyCode,
      }),
    onSuccess: () => {
      setEditing(false);
      onChanged();
    },
  });

  const addAlias = useMutation({
    mutationFn: () =>
      trpc.admin.addAlias.mutate({
        playerId: player.id,
        alias: aliasInput.trim(),
        companyCode: player.companyCode,
      }),
    onSuccess: () => {
      setAliasInput('');
      onChanged();
    },
  });

  const error = update.error ?? addAlias.error;

  return (
    <tr className={player.status !== 'active' ? 'player-inactive' : undefined}>
      <td>
        <input
          type="checkbox"
          checked={mergeSelected}
          onChange={onToggleMerge}
          disabled={player.status !== 'active'}
          title="Select for merge"
        />
      </td>
      <td>
        {editing ? (
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        ) : (
          <>
            <Link to="/players/$playerId" params={{ playerId: player.id }}>
              {player.canonicalName}
            </Link>
            {player.displayName && <span className="muted"> aka “{player.displayName}”</span>}
          </>
        )}
        {error && <div className="error-text">{error.message}</div>}
      </td>
      <td>
        {editing ? (
          <select className="select" value={companyCode} onChange={(e) => setCompanyCode(e.target.value)}>
            <option value="">No company</option>
            {companies.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} — {c.name}
              </option>
            ))}
          </select>
        ) : (
          (player.companyCode ?? '—')
        )}
      </td>
      <td>
        <span className="alias-chips">
          {player.aliases.map((alias) => (
            <span key={alias} className="chip">
              {alias}
            </span>
          ))}
        </span>
        <span className="alias-add">
          <input
            className="input"
            placeholder="add alias…"
            value={aliasInput}
            onChange={(e) => setAliasInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && aliasInput.trim() !== '') addAlias.mutate();
            }}
          />
          <button
            type="button"
            className="btn btn-small"
            disabled={aliasInput.trim() === '' || addAlias.isPending}
            onClick={() => addAlias.mutate()}
          >
            +
          </button>
        </span>
      </td>
      <td>{player.legacyId ?? '—'}</td>
      <td>
        <span className={`chip ${player.status === 'active' ? '' : 'chip-warning'}`}>{player.status}</span>
      </td>
      <td>
        {editing ? (
          <span className="row-actions">
            <button
              type="button"
              className="btn btn-small btn-primary"
              disabled={name.trim() === '' || update.isPending}
              onClick={() => update.mutate()}
            >
              Save
            </button>
            <button type="button" className="btn btn-small" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button type="button" className="btn btn-small" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
      </td>
    </tr>
  );
}

function ClaimsPanel() {
  const queryClient = useQueryClient();
  const claims = useQuery({
    queryKey: ['admin', 'claims'],
    queryFn: () => trpc.admin.claims.query(),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'claims'] });
    void queryClient.invalidateQueries({ queryKey: ['leaderboard'] });
  };

  const pending = (claims.data ?? []).filter((c) => c.status === 'pending');
  const resolved = (claims.data ?? []).filter((c) => c.status !== 'pending');

  return (
    <div className="section">
      <h2>Player claims</h2>
      {claims.isPending && <p className="loading-text">Loading claims…</p>}
      {claims.isError && <p className="error-text">{claims.error.message}</p>}
      {claims.data && claims.data.length === 0 && <p className="muted">No claims yet.</p>}
      {claims.data && claims.data.length > 0 && (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Player</th>
                <th>Note</th>
                <th>When</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {[...pending, ...resolved].map((claim) => (
                <ClaimRow key={claim.id} claim={claim} onChanged={invalidate} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ClaimRow({ claim, onChanged }: { claim: AdminClaim; onChanged: () => void }) {
  const resolve = useMutation({
    mutationFn: (action: 'approved' | 'rejected' | 'revoked') =>
      trpc.admin.resolveClaim.mutate({ claimId: claim.id, action }),
    onSuccess: onChanged,
  });

  return (
    <tr>
      <td>
        {claim.userName} <span className="muted">({claim.userEmail})</span>
      </td>
      <td>
        <Link to="/players/$playerId" params={{ playerId: claim.playerId }}>
          {claim.playerName}
        </Link>
      </td>
      <td>{claim.note ?? ''}</td>
      <td>{timeAgo(claim.createdAt)}</td>
      <td>
        <span
          className={`chip ${
            claim.status === 'approved' ? 'chip-success' : claim.status === 'pending' ? 'chip-warning' : 'chip-danger'
          }`}
        >
          {claim.status}
        </span>
      </td>
      <td>
        <span className="row-actions">
          {claim.status === 'pending' && (
            <>
              <button
                type="button"
                className="btn btn-small btn-primary"
                disabled={resolve.isPending}
                onClick={() => resolve.mutate('approved')}
              >
                Approve
              </button>
              <button
                type="button"
                className="btn btn-small btn-danger"
                disabled={resolve.isPending}
                onClick={() => resolve.mutate('rejected')}
              >
                Reject
              </button>
            </>
          )}
          {claim.status === 'approved' && (
            <button
              type="button"
              className="btn btn-small btn-danger"
              disabled={resolve.isPending}
              onClick={() => resolve.mutate('revoked')}
            >
              Revoke
            </button>
          )}
        </span>
        {resolve.isError && <div className="error-text">{resolve.error.message}</div>}
      </td>
    </tr>
  );
}
