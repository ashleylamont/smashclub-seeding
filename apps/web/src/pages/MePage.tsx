import { Button } from '../components/ui/Button';
import { LoadingState } from '../components/ui/Feedback';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Navigate, useSearch } from '@tanstack/react-router';
import { authClient, useCurrentUser, useSignInOptions } from '../lib/auth';
import { ProfileClaimSection } from '../components/ProfileClaimSection';
import './Auth.css';

const PROVIDERS = [
  { id: 'discord', label: 'Discord' },
  { id: 'google', label: 'Google' },
] as const;

export function MePage() {
  const { data: session, isPending } = authClient.useSession();
  const currentUser = useCurrentUser(session);
  const { claim } = useSearch({ from: '/me' });

  if (isPending) return <p className="loading-text">Loading account…</p>;
  if (!session) return <Navigate to="/login" search={{ claim }} replace />;

  const role = currentUser.data?.role;

  return (
    <div className="me-page">
      <h1>Your account</h1>

      <div className="card">
        <div className="me-account">
          {session.user.image ? (
            <img className="avatar" src={session.user.image} alt="" />
          ) : (
            <span className="avatar-fallback">
              {session.user.name.charAt(0).toUpperCase() || '?'}
            </span>
          )}
          <div>
            <div className="account-name">
              {session.user.name}
              {role === 'admin' && <span className="chip chip-accent">admin</span>}
            </div>
            <div className="muted">{session.user.email}</div>
          </div>
        </div>
        <p className="account-photo-note muted">
          {session.user.image && 'Your account photo comes from your sign-in provider. '}
          Main characters are shown beside your public player name.
        </p>
        <LinkedProviders key={session.user.id} userId={session.user.id} />
      </div>

      <ProfileClaimSection
        key={session.user.id}
        userId={session.user.id}
        targetId={claim}
        claimReviewMode={session.user.emailVerified ? currentUser.data?.claimReviewMode : 'off'}
      />
    </div>
  );
}

function LinkedProviders({ userId }: { userId: string }) {
  const accounts = useQuery({
    queryKey: ['me', 'accounts', userId],
    queryFn: async () => {
      const res = await authClient.listAccounts();
      if (res.error) throw new Error(res.error.message ?? 'Failed to load linked accounts');
      return res.data;
    },
  });
  const options = useSignInOptions();
  const [error, setError] = useState<string | null>(null);

  if (accounts.isPending) return <LoadingState>Loading linked accounts…</LoadingState>;

  const linked = new Set(
    (accounts.data ?? []).map((account) => {
      const a = account as { provider?: string; providerId?: string };
      return (a.provider ?? a.providerId ?? '').toLowerCase();
    }),
  );

  const link = async (provider: (typeof PROVIDERS)[number]['id']) => {
    setError(null);
    try {
      const res = await authClient.linkSocial({ provider, callbackURL: '/me' });
      if (res.error) setError(res.error.message ?? 'Linking failed');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Linking failed');
    }
  };

  const configured = options.isSuccess && !options.isFetching ? options.data.providers : [];
  const providers = PROVIDERS.filter(
    ({ id }) => linked.has(id) || (accounts.isSuccess && configured.includes(id)),
  );
  const canLink = providers.some(({ id }) => !linked.has(id));

  return (
    <>
      {providers.length > 0 && (
        <div className="provider-list">
          {providers.map(({ id, label }) =>
            linked.has(id) ? (
              <span key={id} className="chip">
                ✓ {label} linked
              </span>
            ) : (
              <Button size="small" key={id} type="button" onClick={() => void link(id)}>
                Link {label}
              </Button>
            ),
          )}
        </div>
      )}
      {accounts.isError && (
        <p className="error-text" role="alert">
          {accounts.error.message}
        </p>
      )}
      {options.isPending && <LoadingState>Checking sign-in providers…</LoadingState>}
      {options.isError && (
        <div className="provider-list">
          <p className="error-text" role="alert">
            Couldn’t check available sign-in providers.
          </p>
          <Button size="small" onClick={() => void options.refetch()} pending={options.isFetching}>
            Retry provider options
          </Button>
        </div>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {canLink && (
        <p className="muted">
          Link another provider here to sign in to this account with it. Signing in separately can
          create another account.
        </p>
      )}
    </>
  );
}
