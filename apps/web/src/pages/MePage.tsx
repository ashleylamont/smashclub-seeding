import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate } from '@tanstack/react-router';
import { authClient, sessionRole } from '../lib/auth';
import { trpc } from '../lib/trpc';
import type { MyClaim } from '../lib/apiTypes';
import { formatDate } from '../lib/format';
import './Auth.css';

const PROVIDERS = ['discord', 'google'] as const;

export function MePage() {
  const { data: session, isPending } = authClient.useSession();

  if (isPending) return <p className="loading-text">Loading account…</p>;
  if (!session) return <Navigate to="/login" />;

  const role = sessionRole(session);

  return (
    <div className="me-page">
      <h1>Your account</h1>

      <div className="card">
        <div className="me-account">
          {session.user.image ? (
            <img className="avatar" src={session.user.image} alt="" />
          ) : (
            <span className="avatar-fallback">{session.user.name.charAt(0).toUpperCase() || '?'}</span>
          )}
          <div>
            <div className="account-name">
              {session.user.name}
              {role === 'admin' && <span className="chip chip-accent">admin</span>}
            </div>
            <div className="muted">{session.user.email}</div>
          </div>
        </div>
        <LinkedProviders />
      </div>

      <ClaimSection />
    </div>
  );
}

function LinkedProviders() {
  const accounts = useQuery({
    queryKey: ['me', 'accounts'],
    queryFn: async () => {
      const res = await authClient.listAccounts();
      if (res.error) throw new Error(res.error.message ?? 'Failed to load linked accounts');
      return res.data;
    },
  });
  const [error, setError] = useState<string | null>(null);

  const linked = new Set(
    (accounts.data ?? []).map((account) => {
      const a = account as { provider?: string; providerId?: string };
      return (a.provider ?? a.providerId ?? '').toLowerCase();
    }),
  );

  const link = async (provider: (typeof PROVIDERS)[number]) => {
    setError(null);
    try {
      const res = await authClient.linkSocial({ provider, callbackURL: '/me' });
      if (res.error) setError(res.error.message ?? 'Linking failed');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Linking failed');
    }
  };

  return (
    <div className="provider-list">
      {PROVIDERS.map((provider) =>
        linked.has(provider) ? (
          <span key={provider} className="chip chip-success">
            ✓ {provider === 'discord' ? 'Discord' : 'Google'} linked
          </span>
        ) : (
          <button key={provider} type="button" className="btn btn-small" onClick={() => void link(provider)}>
            Link {provider === 'discord' ? 'Discord' : 'Google'}
          </button>
        ),
      )}
      {accounts.isError && <span className="error-text">{accounts.error.message}</span>}
      {error && <span className="error-text">{error}</span>}
    </div>
  );
}

function ClaimSection() {
  const queryClient = useQueryClient();
  const claims = useQuery({
    queryKey: ['me', 'claims'],
    queryFn: () => trpc.me.claims.query(),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['me', 'claims'] });
    void queryClient.invalidateQueries({ queryKey: ['leaderboard'] });
    void queryClient.invalidateQueries({ queryKey: ['player'] });
  };

  if (claims.isPending) return <p className="loading-text">Loading claim…</p>;
  if (claims.isError) return <p className="error-text">Failed to load claims: {claims.error.message}</p>;

  const liveClaim = claims.data.find((c) => c.status === 'pending' || c.status === 'approved') ?? null;
  const pastClaims = claims.data.filter((c) => c !== liveClaim);

  return (
    <div className="card">
      <h2>Player claim</h2>
      {liveClaim ? (
        <LiveClaim claim={liveClaim} onChanged={invalidate} />
      ) : (
        <ClaimSearch onChanged={invalidate} />
      )}
      {pastClaims.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h3>History</h3>
          <ul className="claim-search-results">
            {pastClaims.map((c) => (
              <li key={c.id}>
                <span>
                  {c.playerName} <span className="muted">({formatDate(c.createdAt)})</span>
                </span>
                <span className={`chip ${c.status === 'rejected' ? 'chip-danger' : ''}`}>{c.status}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function LiveClaim({ claim, onChanged }: { claim: MyClaim; onChanged: () => void }) {
  const withdraw = useMutation({
    mutationFn: () => trpc.me.withdrawClaim.mutate({ claimId: claim.id }),
    onSuccess: onChanged,
  });

  return (
    <div>
      <div className="claim-status">
        <span>
          You claimed{' '}
          <Link to="/players/$playerId" params={{ playerId: claim.playerId }}>
            <strong>{claim.playerName}</strong>
          </Link>
          {claim.companyCode ? ` (${claim.companyCode})` : ''}
        </span>
        <span className={`chip ${claim.status === 'approved' ? 'chip-success' : 'chip-warning'}`}>
          {claim.status === 'approved' ? '✓ approved' : 'pending review'}
        </span>
        <button
          type="button"
          className="btn btn-small btn-danger"
          disabled={withdraw.isPending}
          onClick={() => withdraw.mutate()}
        >
          Withdraw
        </button>
      </div>
      {claim.note && <p className="muted">Note: {claim.note}</p>}
      {withdraw.isError && <p className="error-text">{withdraw.error.message}</p>}
      {claim.status === 'approved' && <DisplayNameEditor claim={claim} onChanged={onChanged} />}
    </div>
  );
}

function DisplayNameEditor({ claim, onChanged }: { claim: MyClaim; onChanged: () => void }) {
  const [displayName, setDisplayName] = useState(claim.displayName ?? '');
  const update = useMutation({
    mutationFn: (name: string | null) =>
      trpc.me.updateDisplayName.mutate({ playerId: claim.playerId, displayName: name }),
    onSuccess: onChanged,
  });

  return (
    <div className="display-name-row">
      <label htmlFor="display-name" className="muted">
        Display name
      </label>
      <input
        id="display-name"
        className="input"
        value={displayName}
        placeholder={claim.canonicalName}
        onChange={(e) => setDisplayName(e.target.value)}
      />
      <button
        type="button"
        className="btn btn-small"
        disabled={update.isPending}
        onClick={() => update.mutate(displayName.trim() === '' ? null : displayName.trim())}
      >
        Save
      </button>
      {update.isSuccess && <span className="chip chip-success">saved</span>}
      {update.isError && <span className="error-text">{update.error.message}</span>}
    </div>
  );
}

function ClaimSearch({ onChanged }: { onChanged: () => void }) {
  const [query, setQuery] = useState('');
  const [note, setNote] = useState('');
  const trimmed = query.trim();

  const search = useQuery({
    queryKey: ['searchPlayers', trimmed],
    queryFn: () => trpc.public.searchPlayers.query({ query: trimmed }),
    enabled: trimmed.length >= 1,
  });

  const request = useMutation({
    mutationFn: (playerId: string) =>
      trpc.me.requestClaim.mutate({ playerId, note: note.trim() === '' ? undefined : note.trim() }),
    onSuccess: onChanged,
  });

  return (
    <div>
      <p className="muted">
        Find yourself on the leaderboard and claim your player. An admin will approve the claim.
      </p>
      <div className="claim-form-row" style={{ marginTop: 10 }}>
        <input
          className="input"
          placeholder="Search players by name…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <input
          className="input"
          placeholder="Optional note for the admins"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      {search.isFetching && <p className="loading-text">Searching…</p>}
      {search.isError && <p className="error-text">{search.error.message}</p>}
      {request.isError && <p className="error-text">{request.error.message}</p>}
      {search.data && search.data.length === 0 && <p className="muted" style={{ marginTop: 10 }}>No players found.</p>}
      {search.data && search.data.length > 0 && (
        <ul className="claim-search-results">
          {search.data.map((player) => (
            <li key={player.id}>
              <span>
                {player.name}
                {player.companyCode ? <span className="muted"> ({player.companyCode})</span> : null}
                {player.verified && (
                  <span className="verified-badge" title="Already claimed">
                    {' '}
                    ✓
                  </span>
                )}
              </span>
              <button
                type="button"
                className="btn btn-small"
                disabled={player.verified || request.isPending}
                onClick={() => request.mutate(player.id)}
              >
                This is me
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
