import { createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';
import { Layout } from './components/Layout';
import { LeaderboardPage } from './pages/LeaderboardPage';
import { PlayerPage } from './pages/PlayerPage';
import { TournamentsPage } from './pages/TournamentsPage';
import { TournamentPage } from './pages/TournamentPage';
import { LoginPage } from './pages/LoginPage';
import { MePage } from './pages/MePage';
import { AdminLayout } from './pages/admin/AdminLayout';
import { AdminTournamentsPage } from './pages/admin/AdminTournamentsPage';
import { AdminReviewPage } from './pages/admin/AdminReviewPage';
import { AdminPlayersPage } from './pages/admin/AdminPlayersPage';
import { AdminCompaniesPage } from './pages/admin/AdminCompaniesPage';
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
  loginRoute,
  meRoute,
  adminRoute.addChildren([
    adminIndexRoute,
    adminTournamentsRoute,
    adminReviewRoute,
    adminPlayersRoute,
    adminCompaniesRoute,
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
