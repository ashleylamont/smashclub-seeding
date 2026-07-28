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
          Sign in to claim your player, track your results, and manage your display name.
        </p>
        <div className="login-buttons">
          <button type="button" className="btn provider-btn discord" onClick={() => void signIn('discord')}>
            <span className="provider-mark">D</span> Continue with Discord
          </button>
          <button type="button" className="btn provider-btn google" onClick={() => void signIn('google')}>
            <span className="provider-mark">G</span> Continue with Google
          </button>
        </div>
        {error && <p className="error-text">{error}</p>}
      </div>
    </div>
  );
}
