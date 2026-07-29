import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { authClient, sessionRole } from '../lib/auth';
import { useEventSource } from '../lib/useEventSource';
import '../App.css';

/** App shell: top nav, routed content, footer. Also holds the global SSE
 *  subscription that keeps cached queries fresh across the whole app. */
export function Layout() {
  const { data: session, isPending } = authClient.useSession();
  const role = sessionRole(session);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  useEventSource('/api/live', (type) => {
    if (type === 'recompute_completed') {
      void queryClient.invalidateQueries({ queryKey: ['leaderboard'] });
      void queryClient.invalidateQueries({ queryKey: ['ratingHistory'] });
      void queryClient.invalidateQueries({ queryKey: ['player'] });
    } else if (type === 'sync_completed' || type === 'set_updated') {
      void queryClient.invalidateQueries({ queryKey: ['tournaments'] });
      void queryClient.invalidateQueries({ queryKey: ['tournament'] });
    }
  });

  const signOut = async () => {
    await authClient.signOut();
    void navigate({ to: '/' });
  };

  const userName = session?.user.name ?? '';
  const userImage = session?.user.image ?? null;

  return (
    <div className="app-shell">
      <nav className="app-nav">
        {/* The lime marquee block is drawn in CSS, so the wordmark is text only. */}
        <Link to="/" className="logo">
          Smash Club
        </Link>
        <div className="nav-links">
          <Link to="/" className="nav-link" activeProps={{ className: 'nav-link active' }} activeOptions={{ exact: true }}>
            Home
          </Link>
          <Link to="/tournaments" className="nav-link" activeProps={{ className: 'nav-link active' }}>
            Tournaments
          </Link>
          {role === 'admin' && (
            <Link to="/admin" className="nav-link" activeProps={{ className: 'nav-link active' }}>
              Admin
            </Link>
          )}
        </div>
        <div className="nav-right">
          {isPending ? null : session ? (
            <>
              <Link to="/me" className="user-chip" title="Your account">
                {userImage ? (
                  <img src={userImage} alt="" className="avatar" />
                ) : (
                  <span className="avatar-fallback">{userName.charAt(0).toUpperCase() || '?'}</span>
                )}
                <span>{userName}</span>
              </Link>
              <button type="button" className="btn btn-small" onClick={() => void signOut()}>
                Sign out
              </button>
            </>
          ) : (
            <Link to="/login" className="btn btn-small">
              Sign in
            </Link>
          )}
        </div>
      </nav>

      <main className="app-main">
        <Outlet />
      </main>

      <footer className="app-footer">Smash Club — club rankings, synced from Challonge</footer>
    </div>
  );
}
