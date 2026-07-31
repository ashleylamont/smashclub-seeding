import { Link, Navigate, Outlet } from '@tanstack/react-router';
import { authClient, sessionRole } from '../../lib/auth';
import './Admin.css';

const TABS = [
  { to: '/admin/tournaments', label: 'Tournaments' },
  { to: '/admin/review', label: 'Review' },
  { to: '/admin/players', label: 'Players' },
  { to: '/admin/companies', label: 'Companies' },
  { to: '/admin/seeding', label: 'Seeding' },
  { to: '/admin/settings', label: 'Settings' },
] as const;

export function AdminLayout() {
  const { data: session, isPending } = authClient.useSession();

  if (isPending) return <p className="loading-text">Checking access…</p>;
  if (!session) return <Navigate to="/login" />;
  if (sessionRole(session) !== 'admin') return <Navigate to="/" />;

  return (
    <div className="admin-layout">
      <div className="admin-header">
        <h1>Admin</h1>
        <nav className="admin-tabs">
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
