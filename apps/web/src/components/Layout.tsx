import { useEffect, useRef } from 'react';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { authClient, sessionRole } from '../lib/auth';
import { BUILD_COMMIT_URL, BUILD_LABEL, BUILD_SHA } from '../lib/build';
import { useEventSource } from '../lib/useEventSource';
import { ThemeToggle } from './ThemeToggle';
import '../App.css';

/** App shell: top nav, routed content, footer. Also holds the global SSE
 *  subscription that keeps cached queries fresh across the whole app. */
export function Layout() {
  const { data: session, isPending } = authClient.useSession();
  const role = sessionRole(session);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const nav = useRef<HTMLElement>(null);

  /*
   * Publishes the nav's height as `--nav-h`.
   *
   * The board's column headers are sticky, and so is the nav — both at
   * `top: 0`, with the nav on top and opaque, so scrolling a long board parked
   * the headers underneath it and the columns went unlabelled exactly when the
   * labels were needed. The height is not a constant to hard-code: the bar is
   * one row on a laptop and two on a phone, it grows when an admin gets a third
   * link, and touch targets change it again. So it is measured.
   */
  useEffect(() => {
    const element = nav.current;
    if (!element) return;
    const publish = () => {
      document.documentElement.style.setProperty('--nav-h', `${Math.round(element.offsetHeight)}px`);
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

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
      {/* The nav is sticky and, on a phone, two rows deep — so a keyboard user
          reaching the board should not have to walk it on every route change. */}
      <a href="#main" className="skip-link">
        Skip to content
      </a>

      <nav className="app-nav" ref={nav}>
        {/* The marquee block is drawn in CSS, so the wordmark is text only. */}
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
          <ThemeToggle />
          {isPending ? null : session ? (
            <>
              <Link to="/me" className="user-chip" title="Your account">
                {userImage ? (
                  <img src={userImage} alt="" className="avatar" />
                ) : (
                  <span className="avatar-fallback" aria-hidden="true">
                    {userName.charAt(0).toUpperCase() || '?'}
                  </span>
                )}
                {/* Taken off-screen rather than removed on narrow widths, where
                    the nav has no room for it: it is the chip's accessible name,
                    and `display: none` would leave the link nameless. */}
                <span className="user-chip-name">{userName}</span>
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

      <main className="app-main" id="main" tabIndex={-1}>
        <Outlet />
      </main>

      <footer className="app-footer">
        <span>Smash Club — club rankings, synced from Challonge</span>
        {/* The build this page was served from, so "is prod actually on the
            new image?" is answerable without kubectl. */}
        <span className="build-tag">
          build{' '}
          {BUILD_COMMIT_URL ? (
            <a href={BUILD_COMMIT_URL} target="_blank" rel="noreferrer" title={BUILD_SHA ?? undefined}>
              {BUILD_LABEL}
            </a>
          ) : (
            BUILD_LABEL
          )}
        </span>
      </footer>
    </div>
  );
}
