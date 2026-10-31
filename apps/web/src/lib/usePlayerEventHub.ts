import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { authClient, type Session } from './auth';
import { eventUnavailable } from './eventErrors';
import { eventPlayers, useDevicePlayer } from './playerSelection';
import { useOnlineStatus } from './useOnlineStatus';
import { useGuestEventAccess } from './useGuestEventAccess';
import { trpc } from './trpc';
import {
  eventPlayOpen,
  scoreApprovalPolicy,
  queueScoringIds,
  usePoolFilter,
  matchesPool,
  type StartPoolMatch,
} from './poolFlow';
import { guestVisibleMatches, includesPlayer, sortPlayerMatches } from './playerMatchView';
import {
  playerHubView,
  effectivePlayerView,
  playerMatchProgress,
  recentPlayerMatches,
  resolveHubPlayer,
} from './playerHubView';
import type { ResultSubmission } from '../components/CompletedScoreReport';

export function usePlayerEventHub(planId: string) {
  const { data: signedIn } = authClient.useSession();
  const online = useOnlineStatus();
  const guest = useGuestEventAccess(planId);
  const { session, redeeming, matches, setError, setReportingPreference } = guest;
  const [search, setSearch] = useState('');
  const [selectedPlayer, persistSelectedPlayer] = useDevicePlayer(
    planId,
    new URLSearchParams(window.location.search).get('player') ?? undefined,
  );
  const setSelectedPlayer = (id: string) => {
    persistSelectedPlayer(id);
    const url = new URL(window.location.href);
    if (url.searchParams.has('player')) {
      if (id) url.searchParams.set('player', id);
      else url.searchParams.delete('player');
      window.history.replaceState(window.history.state, '', url);
    }
  };
  const [preferredView, setView] = useState(selectedPlayer ? 'mine' : 'queue');
  const [selectedPool, setSelectedPool] = usePoolFilter();
  const [selectedStation, setSelectedStation] = useState(
    () => new URLSearchParams(window.location.search).get('station') ?? '',
  );
  const [selectedMatch, setSelectedMatch] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get('match'),
  );
  const [starting, setStarting] = useState<string | null>(null);
  const cache = useQueryClient();
  const publicEvent = useQuery({
    queryKey: ['eventOpsPublic', planId],
    queryFn: () => trpc.eventOps.snapshot.query({ planId }),
    refetchInterval: 2500,
    retry: false,
  });
  const signedReports = useQuery({
    queryKey: ['eventOpsReports', planId, signedIn?.user.id],
    queryFn: () => trpc.eventOps.myReports.query({ planId }),
    enabled: Boolean(signedIn),
    refetchInterval: 2500,
    retry: false,
  });
  const claims = useQuery({
    queryKey: ['me', 'claims', signedIn?.user.id],
    queryFn: () => trpc.me.claims.query(),
    enabled: Boolean(signedIn),
  });
  const unpublished = eventUnavailable(publicEvent.error);
  const eventPlan = (publicEvent.data ?? matches.data)?.plan;
  const playOpen = eventPlayOpen(eventPlan);
  // Only the public snapshot drives browsing; private reporting responses never widen visibility.
  const data = unpublished ? undefined : publicEvent.data;
  const { guestCredential, signedCredential, reporter, reportingIdentity } = reportingAccess(
    guest,
    signedIn,
    data,
  );
  const canWrite =
    online &&
    playOpen &&
    !publicEvent.isError &&
    (reporter === 'guest' ? guestCredential : signedCredential) &&
    !redeeming &&
    !['complete', 'cancelled'].includes(data?.plan.status ?? '');
  const ownReports =
    reporter === 'guest'
      ? matches.data?.reports
      : reporter === 'signed-in'
        ? signedReports.data
        : undefined;
  const claim = signedIn ? claims.data?.find((item) => item.status === 'approved') : undefined;
  const disputeMode =
    (publicEvent.data ?? matches.data)?.settings.scoreReportingMode === 'approve_unless_disputed' &&
    (publicEvent.data ?? matches.data)?.plan.bracketMode === 'native';
  const hasAutomaticReports = data?.matches.some(
    (match) => scoreApprovalPolicy(data, match) !== 'review',
  );
  const closed = data !== undefined && ['complete', 'cancelled'].includes(data.plan.status);
  const players = eventPlayers(data?.matches ?? []);
  const player = resolveHubPlayer(players, selectedPlayer, data?.entrants);
  const view = effectivePlayerView(preferredView, player);
  const playerName = players.find((item) => item.id === player)?.name;
  const reportedIds = new Set(ownReports?.map((report) => report.matchId));
  const queuedIds = data ? queueScoringIds(data) : new Set<string>();
  const stationId =
    data?.stations.find(
      (station) =>
        station.id === selectedStation ||
        station.name.toLowerCase() === selectedStation.toLowerCase(),
    )?.id ?? '';
  const stationQueue = data?.stationQueues?.find((queue) => queue.stationId === stationId);
  const stationMatchIds = new Set([
    stationQueue?.currentMatchId,
    stationQueue?.nextMatchId,
    ...(stationQueue?.upcoming.map((item) => item.matchId) ?? []),
  ]);
  const matching = guestVisibleMatches(data, {
    stationId,
    stationMatchIds,
    selectedMatch,
    selectedPool: player && view === 'mine' ? '' : selectedPool,
    playerId: player,
    view,
    search,
    disputeMode,
    reportedIds,
    queuedIds,
  });
  const visible =
    player && view === 'mine' ? recentPlayerMatches(matching, 3, reportedIds) : matching;
  const hiddenHistory = matching.length - visible.length;
  const board = data ? playerHubView(data, player, selectedPool) : undefined;
  const [initialSection] = useState(() =>
    /^#(?:my-matches|what-next|event-pools|event-brackets|event-results)$/.test(
      window.location.hash,
    )
      ? window.location.hash.slice(1)
      : '',
  );
  const initialSectionOpened = useRef(false);
  useEffect(() => {
    if (!data || !initialSection || initialSectionOpened.current) return;
    initialSectionOpened.current = true;
    const frame = requestAnimationFrame(() =>
      document.getElementById(initialSection)?.scrollIntoView(),
    );
    return () => cancelAnimationFrame(frame);
  }, [data, initialSection]);
  const start = async (input: StartPoolMatch) => {
    if (!canWrite) return;
    setStarting(input.matchId);
    setError('');
    try {
      if (reporter === 'guest' && session)
        await trpc.eventOps.guests.startPoolMatch.mutate({
          planId,
          sessionToken: session.sessionToken,
          ...input,
        });
      else await trpc.eventOps.startPoolMatch.mutate({ planId, ...input });
      setSelectedMatch(input.matchId);
      await Promise.all([
        cache.invalidateQueries({ queryKey: ['guestMatches', planId] }),
        cache.invalidateQueries({ queryKey: ['eventOpsPublic', planId] }),
      ]);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The station queue changed. Refresh before starting.',
      );
    } finally {
      setStarting(null);
    }
  };
  const chooseMatch = (id: string) => {
    const match = data?.matches.find((item) => item.id === id);
    if (match && selectedPool && !matchesPool(match, selectedPool)) setSelectedPool('');
    if (match && player && !includesPlayer(match, player)) setSelectedPlayer('');
    if (match && stationId && match.stationId !== stationId && !stationMatchIds.has(id))
      setSelectedStation('');
    setSelectedMatch(id);
    setView('queue');
    setSearch('');
    document.getElementById('my-matches')?.scrollIntoView({ behavior: 'smooth' });
  };
  const playerMatches =
    data && player
      ? sortPlayerMatches(
          data,
          data.matches.filter((match) => includesPlayer(match, player)),
        )
      : [];
  const { completed, nextMatch, waitingMatch } = playerMatchProgress(playerMatches, closed);
  const submitScore = async (matchId: string, input: ResultSubmission) => {
    if (!canWrite || closed) throw new Error('Match reporting is currently unavailable.');
    const result =
      reporter === 'guest' && session
        ? await trpc.eventOps.guests.submit.mutate({
            planId,
            sessionToken: session.sessionToken,
            matchId,
            ...input,
          })
        : await trpc.eventOps.reportScore.mutate({
            matchId,
            ...input,
            outcome: 'played',
          });
    await Promise.all([
      cache.invalidateQueries({ queryKey: ['guestMatches', planId] }),
      cache.invalidateQueries({ queryKey: ['eventOpsPublic', planId] }),
      cache.invalidateQueries({ queryKey: ['eventOpsReports', planId] }),
    ]);
    return result;
  };
  return {
    ...guest,
    planId,
    signedIn,
    online,
    publicEvent,
    unpublished,
    data,
    signedCredential,
    guestCredential,
    reporter,
    reportingIdentity,
    canWrite,
    ownReports,
    claim,
    playOpen,
    closed,
    players,
    player,
    playerName,
    playerMatches,
    completed,
    nextMatch,
    waitingMatch,
    board,
    hiddenHistory,
    selectedPool,
    setSelectedPool,
    selectedStation,
    setSelectedStation,
    selectedMatch,
    setSelectedMatch,
    selectedPlayer,
    setSelectedPlayer,
    view,
    setView,
    search,
    setSearch,
    visible,
    stationId,
    starting,
    start,
    chooseMatch,
    submitScore,
    hasAutomaticReports,
    setReportingPreference,
  };
}
export type PlayerEventHub = ReturnType<typeof usePlayerEventHub>;
export type PublicEventSnapshot = NonNullable<PlayerEventHub['data']>;

function reportingAccess(
  guest: ReturnType<typeof useGuestEventAccess>,
  signedIn: Session,
  data: Awaited<ReturnType<typeof trpc.eventOps.snapshot.query>> | undefined,
) {
  const { valid, redeeming, matches, session, reportingPreference, cacheId, passVersion } = guest;
  const guestCredential = valid && !redeeming && Boolean(matches.data) && !matches.isError;
  const signedCredential = Boolean(signedIn) && Boolean(data?.settings.playerReports);
  // A polling outage or revocation disables the chosen pass without silently changing attribution.
  const reporter =
    session && reportingPreference === 'guest' ? 'guest' : signedCredential ? 'signed-in' : null;
  const reportingIdentity =
    reporter === 'guest'
      ? `guest:${cacheId}:${passVersion}`
      : reporter === 'signed-in'
        ? `account:${signedIn!.user.id}`
        : 'anonymous';
  return { guestCredential, signedCredential, reporter, reportingIdentity };
}
