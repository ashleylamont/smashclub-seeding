import { useEffect, useRef } from 'react';
import { Link, Navigate, Outlet, useRouterState } from '@tanstack/react-router';
import { authClient, sessionRole } from '../../lib/auth';
import './Admin.css';

const TABS = [
  { to: '/admin/tournaments', label: 'Tournaments' },
  { to: '/admin/review', label: 'Review' },
  { to: '/admin/players', label: 'Players' },
  { to: '/admin/companies', label: 'Companies' },
  { to: '/admin/import', label: 'Import' },
  { to: '/admin/seeding', label: 'Seeding' },
  { to: '/admin/settings', label: 'Settings' },
] as const;

export function AdminLayout() {
  const { data: session, isPending } = authClient.useSession();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const tabs = useRef<HTMLElement>(null);

  /*
   * Keeps the current section visible in the tab strip.
   *
   * Seven tabs do not fit a phone, so below the fold-point the strip scrolls
   * sideways rather than wrapping into three rows. Settings then starts off the
   * right edge — you land on the page you asked for with no tab marked. This
   * nudges the strip's own scroll position, deliberately not `scrollIntoView`,
   * which would also scroll the page vertically to reach a bar that is already
   * on screen.
   */
  useEffect(() => {
    const strip = tabs.current;
    const active = strip?.querySelector<HTMLElement>('.admin-tab.active');
    if (!strip || !active) return;
    const overflowsRight = active.offsetLeft + active.offsetWidth > strip.scrollLeft + strip.clientWidth;
    const overflowsLeft = active.offsetLeft < strip.scrollLeft;
    if (overflowsRight || overflowsLeft) {
      strip.scrollTo({ left: Math.max(0, active.offsetLeft - 16), behavior: 'auto' });
    }
  }, [pathname]);

  if (isPending) return <p className="loading-text">Checking access…</p>;
  if (!session) return <Navigate to="/login" />;
  if (sessionRole(session) !== 'admin') return <Navigate to="/" />;

  return (
    <div className="admin-layout">
      <div className="admin-header">
        <h1>Admin</h1>
        <nav className="admin-tabs" aria-label="Admin sections" ref={tabs}>
          {TABS.map((tab) => (
            <Link key={tab.to} to={tab.to} className="admin-tab" activeProps={{ className: 'admin-tab active' }}>
              {tab.label}
            </Link>
          ))}
        </nav>
      </div>
      <Outlet />
    </div>
  );
}
