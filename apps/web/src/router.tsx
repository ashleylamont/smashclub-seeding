import { createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';
import { Layout } from './components/Layout';
import { LeaderboardPage } from './pages/LeaderboardPage';
import { PlayerPage } from './pages/PlayerPage';
import { TournamentsPage } from './pages/TournamentsPage';
import { TournamentPage } from './pages/TournamentPage';
import { RecapPage } from './pages/RecapPage';
import { VenuePage } from './pages/VenuePage';
import { LoginPage } from './pages/LoginPage';
import { MePage } from './pages/MePage';
import { AdminLayout } from './pages/admin/AdminLayout';
import { AdminTournamentsPage } from './pages/admin/AdminTournamentsPage';
import { AdminReviewPage } from './pages/admin/AdminReviewPage';
import { AdminPlayersPage } from './pages/admin/AdminPlayersPage';
import { AdminCompaniesPage } from './pages/admin/AdminCompaniesPage';
import { AdminImportPage } from './pages/admin/AdminImportPage';
import { AdminSeedingPage } from './pages/admin/AdminSeedingPage';
import { AdminSettingsPage } from './pages/admin/AdminSettingsPage';

const rootRoute = createRootRoute({ component: Layout });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: LeaderboardPage,
});

const playerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/players/$playerId',
  component: PlayerPage,
});

const tournamentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tournaments',
  component: TournamentsPage,
});

const tournamentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tournaments/$slug',
  component: TournamentPage,
});

/**
 * Venue mode. Nested under the tournament so the URL reads as a view of that
 * bracket; it hides the app shell itself rather than living outside the root
 * layout, which keeps every other route's chrome untouched.
 */
const venueRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tournaments/$slug/live',
  component: VenuePage,
});

/**
 * A night's recap. Addressed by a tournament slug rather than a date so an
 * existing bracket link maps onto it, and any bracket of the evening resolves
 * to the same night.
 */
const recapRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/recaps/$slug',
  component: RecapPage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
});

const meRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/me',
  component: MePage,
});

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin',
  component: AdminLayout,
});

const adminIndexRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/admin/tournaments' });
  },
});

const adminTournamentsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/tournaments',
  component: AdminTournamentsPage,
});

const adminReviewRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/review',
  component: AdminReviewPage,
});

const adminPlayersRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/players',
  component: AdminPlayersPage,
});

const adminCompaniesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/companies',
  component: AdminCompaniesPage,
});

const adminImportRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/import',
  component: AdminImportPage,
});

const adminSeedingRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/seeding',
  component: AdminSeedingPage,
});

const adminSettingsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/settings',
  component: AdminSettingsPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  playerRoute,
  tournamentsRoute,
  tournamentRoute,
  venueRoute,
  recapRoute,
  loginRoute,
  meRoute,
  adminRoute.addChildren([
    adminIndexRoute,
    adminTournamentsRoute,
    adminReviewRoute,
    adminPlayersRoute,
    adminCompaniesRoute,
    adminImportRoute,
    adminSeedingRoute,
    adminSettingsRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
