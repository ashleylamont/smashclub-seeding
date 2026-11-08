import { Button } from '../components/ui/Button';
import { useState } from 'react';
import { Navigate, useSearch } from '@tanstack/react-router';
import { authClient, useSignInOptions } from '../lib/auth';
import { LocalSignIn } from './LocalSignIn';
import { profileAccountPath } from '../lib/profileClaim';
import './Auth.css';

export function LoginPage() {
  const { data: session, isPending } = authClient.useSession();
  const { claim } = useSearch({ from: '/login' });
  const callbackURL = profileAccountPath(claim);
  const options = useSignInOptions();
  const [error, setError] = useState<string | null>(null);

  if (!isPending && session) return <Navigate to="/me" search={{ claim }} replace />;

  const signIn = async (provider: 'discord' | 'google') => {
    setError(null);
    try {
      const res = await authClient.signIn.social({ provider, callbackURL });
      if (res.error) setError(res.error.message ?? 'Sign-in failed');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-card card">
        <h1>Sign in</h1>
        <p className="muted">
          {claim
            ? 'Continue to your account to request a claim or edit your linked player profile.'
            : 'Claim your player profile and edit your public alias and main characters.'}
        </p>
        {options.isPending && <p role="status">Loading sign-in options…</p>}
        {options.error && (
          <div>
            <p className="error-text" role="alert">
              {options.error.message}
            </p>
            <Button onClick={() => void options.refetch()} pending={options.isFetching}>
              Retry sign-in options
            </Button>
          </div>
        )}
        {options.data?.credentials && <LocalSignIn callbackURL={callbackURL} />}
        <div className="login-buttons">
          {options.data?.providers.includes('discord') && (
            <Button
              type="button"
              className="provider-btn discord"
              onClick={() => void signIn('discord')}
            >
              <span className="provider-mark">D</span> Continue with Discord
            </Button>
          )}
          {options.data?.providers.includes('google') && (
            <Button
              type="button"
              className="provider-btn google"
              onClick={() => void signIn('google')}
            >
              <span className="provider-mark">G</span> Continue with Google
            </Button>
          )}
        </div>
        {options.data && !options.data.credentials && options.data.providers.length === 0 && (
          <p role="status">Sign-in is not configured. Ask the organiser to enable a provider.</p>
        )}
        {error && <p className="error-text">{error}</p>}
        {/* Signing in with the other provider mints a second account rather than
            finding the first — nothing can match them up before you have proven
            you own both. Linking from /me is what joins them, and it works
            regardless of whether the two addresses match. */}
        {Boolean(options.data?.providers.length) && (
          <p className="muted login-note">
            Use your original provider to sign in, then link another from your account page. Signing
            in separately creates another account.
          </p>
        )}
      </div>
    </div>
  );
}
