import { useState, type FormEvent } from 'react';
import { Button } from '../components/ui/Button';
import { Select, SelectItem } from '../components/ui/Select';
import { Input } from '../components/ui/Input';
import { authClient } from '../lib/auth';

/** Only rendered when the API explicitly enables rehearsal credentials. */
export function LocalSignIn() {
  const [email, setEmail] = useState('admin@smashclub.dev');
  const [password, setPassword] = useState('devpassword123');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const result = await authClient.signIn.email({ email, password });
      if (result.error) setError(result.error.message ?? 'Sign-in failed');
      else window.location.assign('/me');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign-in failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="local-sign-in" onSubmit={(event) => void signIn(event)}>
      <h2>Local rehearsal</h2>
      <p className="muted">Sample accounts and event data reset when the harness restarts.</p>
      <label htmlFor="local-account">Account</label>
      <Select
        id="local-account"
        className="input"
        value={email}
        onValueChange={setEmail}
        disabled={pending}
      >
        <SelectItem value="admin@smashclub.dev">Administrator</SelectItem>
        <SelectItem value="player@smashclub.dev">Player (profile claim)</SelectItem>
        <SelectItem value="rehearsal-player@smashclub.dev">Event player</SelectItem>
        <SelectItem value="organiser@smashclub.dev">Event organiser</SelectItem>
      </Select>
      <label htmlFor="local-password">Password</label>
      <Input
        id="local-password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        required
        disabled={pending}
      />
      <p className="muted">
        Sample password: <code>devpassword123</code>
      </p>
      <Button type="submit" variant="primary" pending={pending}>
        Sign in to rehearsal
      </Button>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
