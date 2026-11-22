import { Button } from './ui/Button';
import { useEffect, useRef } from 'react';
import { Link, Outlet, useMatch, useNavigate, useRouterState } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { authClient, useCurrentUser } from '../lib/auth';
import { APP_VERSION, BUILD_COMMIT_URL, BUILD_LABEL, BUILD_SHA } from '../lib/build';
import { useEventSource } from '../lib/useEventSource';
import { FeedbackDialog } from './FeedbackDialog';
import { NemesisMark } from './NemesisMark';
import { ThemeToggle } from './ThemeToggle';
import { operatorDestination } from '../lib/operatorDestination';
import {
  accountDraftSource,
  clearOtherAccountScoreDrafts,
  clearScoreDrafts,
  useScoreDraftOwner,
} from '../lib/scoreDraftSession';
import '../App.css';

/** App shell: top nav, routed content, footer. Also holds the global SSE
 *  subscription that keeps cached queries fresh across the whole app. */
export function Layout() {
  const { data: session, isPending, error } = authClient.useSession();
  const draftOwner = useScoreDraftOwner(
    'account',
    accountDraftSource(session, isPending || Boolean(error)),
  );
  useEffect(() => {
    if (draftOwner !== undefined) clearOtherAccountScoreDrafts(draftOwner);
  }, [draftOwner]);
  const currentUser = useCurrentUser(session);
  const role = currentUser.data?.role;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const operatorRoute = useMatch({ from: '/operate/$planId', shouldThrow: false });
  const signInTarget =
    operatorRoute &&
    operatorDestination({
      operate: operatorRoute.params.planId,
      view: operatorRoute.search.view,
      station: operatorRoute.search.station,
    });
  const venueDisplay = useRouterState({
    select: (state) => state.matches.some((match) => match.routeId === '/tournaments/$slug/live'),
  });
  const standaloneDisplay = /^\/(live|overlay)\/[^/]+\/?$/.test(pathname);
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
      document.documentElement.style.setProperty(
        '--nav-h',
        `${Math.round(element.offsetHeight)}px`,
      );
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(element);
    return () => observer.disconnect();
  }, [standaloneDisplay]);

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
    clearScoreDrafts();
    await authClient.signOut();
    await navigate({ to: '/' });
    // A mounted editor may have persisted an edit while sign-out was in flight.
    clearScoreDrafts();
  };

  const userName = session?.user.name ?? '';
  const userImage = session?.user.image ?? null;

  if (standaloneDisplay)
    return (
      <main id="main">
        <Outlet />
      </main>
    );

  return (
    <div className="app-shell">
      {/* The nav is sticky and, on a phone, two rows deep — so a keyboard user
          reaching the board should not have to walk it on every route change. */}
      <a href="#main" className="skip-link">
        Skip to content
      </a>

      <nav className="app-nav" ref={nav}>
        {/* The event screens and site navigation share the Nemesis mark. */}
        <Link to="/" className="logo">
          <NemesisMark /> Smash Club
        </Link>
        <div className="nav-links">
          <Link
            to="/"
            className="nav-link"
            activeProps={{ className: 'nav-link active' }}
            activeOptions={{ exact: true }}
          >
            Home
          </Link>
          <Link
            to="/tournaments"
            className="nav-link"
            activeProps={{ className: 'nav-link active' }}
          >
            Tournaments
          </Link>
          <Link to="/play" className="nav-link" activeProps={{ className: 'nav-link active' }}>
            Event night
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
              <Button size="small" type="button" onClick={() => void signOut()}>
                Sign out
              </Button>
            </>
          ) : (
            <Button asChild size="small">
              <Link to="/login" search={signInTarget ?? {}}>
                Sign in
              </Link>
            </Button>
          )}
        </div>
      </nav>

      <main className="app-main" id="main" tabIndex={-1}>
        <Outlet />
      </main>

      <footer className="app-footer">
        <span>Smash Club</span>
        <div className="app-footer-links">
          <Link to="/changelog">Changelog</Link>
          {/* Venue CSS hides the footer, but dialog content is portalled outside it. */}
          {!venueDisplay && <FeedbackDialog />}
        </div>
        {/* The build this page was served from, so "is prod actually on the
            new image?" is answerable without kubectl. */}
        <span className="build-tag">
          <span className="app-version">v{APP_VERSION}</span> <span aria-hidden="true">·</span>{' '}
          build{' '}
          <span className="build-label">
            {BUILD_COMMIT_URL ? (
              <a
                href={BUILD_COMMIT_URL}
                target="_blank"
                rel="noreferrer"
                title={BUILD_SHA ?? undefined}
              >
                {BUILD_LABEL}
              </a>
            ) : (
              BUILD_LABEL
            )}
          </span>
        </span>
      </footer>
    </div>
  );
}
