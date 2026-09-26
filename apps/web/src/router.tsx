import { createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';
import { Layout } from './components/Layout';
import { LeaderboardPage } from './pages/LeaderboardPage';
import { PlayerPage } from './pages/PlayerPage';
import { TournamentsPage } from './pages/TournamentsPage';
import { TournamentPage } from './pages/TournamentPage';
import { EventPage } from './pages/EventPage';
import { RecapPage } from './pages/RecapPage';
import { EventLivePage, EventOverlayPage } from './pages/EventLivePage';
import { AdminEventOperationsPage } from './pages/admin/AdminEventOperationsPage';
import { EventOperatorPage } from './pages/EventOperatorPage';
import { EventNightsPage } from './pages/EventNightsPage';
import { PlayerEventPage } from './pages/PlayerEventPage';
import { GuestEventPage } from './pages/GuestEventPage';
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
import { AdminEventPlannerPage } from './pages/admin/eventPlanner/AdminEventPlannerPage';
import { AdminSettingsPage } from './pages/admin/AdminSettingsPage';
import { AdminBreakthroughPage } from './pages/admin/AdminBreakthroughPage';
import { breakthroughSearch } from './lib/breakthrough';

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

const eventRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/events/$slug',
  component: EventPage,
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

/**
 * Which plan and which step are in the URL, not in component state. An event is
 * run off this screen by more than one person — the organiser sets it up on a
 * laptop, somebody else records pool results on a phone — so a refresh, a
 * back button or a pasted link has to land on the same place.
 */
const adminEventPlannerRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/event-planner',
  component: AdminEventPlannerPage,
  validateSearch: (search: Record<string, unknown>): { plan?: string; step?: string } => ({
    ...(typeof search.plan === 'string' && search.plan !== '' ? { plan: search.plan } : {}),
    ...(typeof search.step === 'string' && search.step !== '' ? { step: search.step } : {}),
  }),
});

const adminSettingsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/settings',
  component: AdminSettingsPage,
});

const adminBreakthroughRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/breakthroughs',
  component: AdminBreakthroughPage,
  validateSearch: breakthroughSearch,
});

const eventLiveRoute = createRoute({ getParentRoute: () => rootRoute, path: '/live/$planId', component: EventLivePage });
const eventOverlayRoute = createRoute({ getParentRoute: () => rootRoute, path: '/overlay/$planId', component: EventOverlayPage });
const eventGuestRoute = createRoute({ getParentRoute: () => rootRoute, path: '/guest/$planId', component: GuestEventPage });
const eventNightsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/play', component: EventNightsPage });
const eventPlayRoute = createRoute({ getParentRoute: () => rootRoute, path: '/play/$planId', component: PlayerEventPage });
const eventOperateRoute = createRoute({ getParentRoute: () => rootRoute, path: '/operate/$planId', component: EventOperatorPage });
const adminEventOperationsRoute = createRoute({ getParentRoute: () => adminRoute, path: '/event-operations', component: AdminEventOperationsPage,
  validateSearch: (search: Record<string, unknown>): { plan?: string } => typeof search.plan === 'string' ? { plan: search.plan } : {},
});

const routeTree = rootRoute.addChildren([
  eventNightsRoute, eventLiveRoute, eventOverlayRoute, eventPlayRoute, eventOperateRoute, eventGuestRoute,
  indexRoute,
  playerRoute,
  tournamentsRoute,
  tournamentRoute,
  eventRoute,
  venueRoute,
  recapRoute,
  loginRoute,
  meRoute,
  adminRoute.addChildren([
    adminIndexRoute,
    adminTournamentsRoute,
    adminBreakthroughRoute,
    adminReviewRoute,
    adminPlayersRoute,
    adminCompaniesRoute,
    adminImportRoute,
    adminSeedingRoute,
    adminEventPlannerRoute,
    adminEventOperationsRoute,
    adminSettingsRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
