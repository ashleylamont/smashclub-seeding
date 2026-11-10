import { Button } from '../components/ui/Button';
import { LoadingState } from '../components/ui/Feedback';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Navigate, useSearch } from '@tanstack/react-router';
import { authClient, useCurrentUser } from '../lib/auth';
import { ProfileClaimSection } from '../components/ProfileClaimSection';
import './Auth.css';

const PROVIDERS = ['discord', 'google'] as const;

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
          Your account photo comes from your sign-in provider. Main characters are shown beside your
          public player name.
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
  const [error, setError] = useState<string | null>(null);

  if (accounts.isPending) return <LoadingState>Loading linked accounts…</LoadingState>;

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

  const unlinked = PROVIDERS.filter((provider) => !linked.has(provider));

  return (
    <>
      <div className="provider-list">
        {PROVIDERS.map((provider) =>
          linked.has(provider) ? (
            <span key={provider} className="chip">
              ✓ {provider === 'discord' ? 'Discord' : 'Google'} linked
            </span>
          ) : (
            <Button size="small" key={provider} type="button" onClick={() => void link(provider)}>
              Link {provider === 'discord' ? 'Discord' : 'Google'}
            </Button>
          ),
        )}
        {accounts.isError && <span className="error-text">{accounts.error.message}</span>}
        {error && <span className="error-text">{error}</span>}
      </div>
      {/* Prompted rather than buried, because the failure mode is silent: sign
          in with the unlinked provider some day and you get a second, empty
          account instead of this one. */}
      {accounts.data && unlinked.length > 0 && (
        <p className="muted">
          Link{' '}
          {unlinked
            .map((provider) => (provider === 'discord' ? 'Discord' : 'Google'))
            .join(' and ')}{' '}
          so you can sign in either way and still land on this account. A different email address on
          the other provider is fine.
        </p>
      )}
    </>
  );
}
