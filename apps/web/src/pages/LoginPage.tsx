import { useState } from 'react';
import { Navigate } from '@tanstack/react-router';
import { authClient } from '../lib/auth';
import './Auth.css';

export function LoginPage() {
  const { data: session, isPending } = authClient.useSession();
  const [error, setError] = useState<string | null>(null);

  if (!isPending && session) return <Navigate to="/me" />;

  const signIn = async (provider: 'discord' | 'google') => {
    setError(null);
    try {
      const res = await authClient.signIn.social({ provider, callbackURL: '/me' });
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
          Claim your player profile and edit your public alias and characters.
        </p>
        <div className="login-buttons">
          <button
            type="button"
            className="btn provider-btn discord"
            onClick={() => void signIn('discord')}
          >
            <span className="provider-mark">D</span> Continue with Discord
          </button>
          <button
            type="button"
            className="btn provider-btn google"
            onClick={() => void signIn('google')}
          >
            <span className="provider-mark">G</span> Continue with Google
          </button>
        </div>
        {error && <p className="error-text">{error}</p>}
        {/* Signing in with the other provider mints a second account rather than
            finding the first — nothing can match them up before you have proven
            you own both. Linking from /me is what joins them, and it works
            regardless of whether the two addresses match. */}
        <p className="muted login-note">
          Use your original provider to sign in, then link another from your account page. Signing
          in separately creates another account.
        </p>
      </div>
    </div>
  );
}
