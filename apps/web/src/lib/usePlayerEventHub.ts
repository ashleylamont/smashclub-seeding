import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { authClient, useMyClaims, type Session } from './auth';
import { eventUnavailable } from './eventErrors';
import { eventPlayers, useDevicePlayer } from './playerSelection';
import { useOnlineStatus } from './useOnlineStatus';
import { useGuestEventAccess } from './useGuestEventAccess';
import { trpc } from './trpc';
import { matchPresentation } from './matchPresentation';
import {
  accountDraftSource,
  clearScoreDrafts,
  storedScoreDraftOwner,
  useScoreDraftOwner,
} from './scoreDraftSession';
import { useScoreReportDrafts, type ScoreDraftRecovery } from './useScoreReportDrafts';
import {
  eventPlayOpen,
  scoreApprovalPolicy,
  usePoolFilter,
  matchesPool,
  type PoolFlowMatch,
  type StartPoolMatch,
} from './poolFlow';
import {
  guestVisibleMatches,
  includesPlayer,
  sortPlayerMatches,
  stationQueueMatchIds,
} from './playerMatchView';
import {
  playerHubView,
  effectivePlayerView,
  playerMatchProgress,
  recentPlayerMatches,
  resolveHubPlayer,
} from './playerHubView';
import type { ResultSubmission } from '../components/CompletedScoreReport';

export function usePlayerEventHub(planId: string) {
  const auth = authClient.useSession();
  const signedIn = auth.data;
  const online = useOnlineStatus();
  const guest = useGuestEventAccess(planId);
  const { session, redeeming, matches, setError } = guest;
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
  const [preferredView, setView] = useState<string>();
  const [linkedDefaultAllowed, setLinkedDefaultAllowed] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return !(
      params.has('pool') ||
      params.has('station') ||
      params.has('match') ||
      window.location.hash
    );
  });
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
  const reporting = usePlayerReporting(planId, auth, guest, publicEvent, online);
  const { data, reporter, canWrite, closed, ownReports } = reporting;
  const claims = useMyClaims(signedIn?.user.id);
  const claim = signedIn ? claims.data?.find((item) => item.status === 'approved') : undefined;
  const disputeMode =
    (publicEvent.data ?? matches.data)?.settings.scoreReportingMode === 'approve_unless_disputed' &&
    (publicEvent.data ?? matches.data)?.plan.bracketMode === 'native';
  const hasAutomaticReports = data?.matches.some(
    (match) => scoreApprovalPolicy(data, match) !== 'review',
  );
  const players = eventPlayers(data?.matches ?? [], data?.entrants);
  // A linked profile supplies browsing context only, without persisting the account's player ID.
  const linkedPlayerId =
    linkedDefaultAllowed && !session && !redeeming ? claim?.playerId : undefined;
  const player = resolveHubPlayer(players, selectedPlayer ?? linkedPlayerId ?? '', data?.entrants);
  const usingLinkedDefault = selectedPlayer === undefined && Boolean(player);
  const view = effectivePlayerView(preferredView, player, selectedPlayer);
  const keepBrowsingScope = () => {
    // An account response arriving after the user starts browsing cannot narrow their view.
    if (!player) setLinkedDefaultAllowed(false);
  };
  const scoped =
    <T>(update: (value: T) => void) =>
    (value: T) => {
      keepBrowsingScope();
      update(value);
    };
  const playerName = players.find((item) => item.id === player)?.name;
  const reportedIds = new Set(ownReports?.map((report) => report.matchId));
  const stationId =
    data?.stations.find(
      (station) =>
        station.id === selectedStation ||
        station.name.toLowerCase() === selectedStation.toLowerCase(),
    )?.id ?? '';
  const stationMatchIds = stationQueueMatchIds(closed ? undefined : data, stationId);
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
  });
  const visible =
    player && view === 'mine' ? recentPlayerMatches(matching, 3, reportedIds) : matching;
  const hiddenHistory = matching.length - visible.length;
  const board = data ? playerHubView(data, player, selectedPool) : undefined;
  const [initialSection] = useState(() =>
    /^#(?:my-matches|what-next|event-pools|event-brackets|event-results|event-archive)$/.test(
      window.location.hash,
    )
      ? window.location.hash.slice(1)
      : '',
  );
  const initialSectionOpened = useRef(false);
  useEffect(() => {
    if (!data || !initialSection || initialSectionOpened.current) return;
    const frame = requestAnimationFrame(() => {
      initialSectionOpened.current = true;
      const section = document.getElementById(initialSection);
      // The directory asks for the archive entry. An old link whose section was
      // omitted can still open the archive at its available content.
      const target =
        section ?? document.querySelector<HTMLElement>('.player-event-hub [data-archive-entry]');
      if (!section) target?.focus({ preventScroll: true });
      target?.scrollIntoView();
    });
    return () => cancelAnimationFrame(frame);
  }, [data, initialSection]);
  const start = async (input: StartPoolMatch) => {
    if (!canWrite) return;
    keepBrowsingScope();
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
    keepBrowsingScope();
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
    return {
      reportId: 'reportId' in result ? result.reportId : result.id,
      status: result.status,
      isDispute: result.isDispute,
    };
  };
  return {
    ...guest,
    planId,
    signedIn,
    online,
    publicEvent,
    ...reporting,
    claim,
    players,
    player,
    playerName,
    usingLinkedDefault,
    playerMatches,
    completed,
    nextMatch,
    waitingMatch,
    board,
    hiddenHistory,
    selectedPool,
    setSelectedPool: scoped(setSelectedPool),
    selectedStation,
    setSelectedStation: scoped(setSelectedStation),
    selectedMatch,
    setSelectedMatch,
    selectedPlayer,
    setSelectedPlayer,
    view,
    setView: scoped(setView),
    search,
    setSearch: scoped(setSearch),
    visible,
    stationId,
    starting,
    keepBrowsingScope,
    start,
    chooseMatch,
    submitScore,
    hasAutomaticReports,
  };
}
export type PlayerEventHub = ReturnType<typeof usePlayerEventHub>;
export type PublicEventSnapshot = Awaited<ReturnType<typeof trpc.eventOps.snapshot.query>>;

function usePlayerReporting(
  planId: string,
  auth: ReturnType<typeof authClient.useSession>,
  guest: ReturnType<typeof useGuestEventAccess>,
  publicEvent: UseQueryResult<PublicEventSnapshot>,
  online: boolean,
) {
  const { data: signedIn, isPending: authPending, error: authError } = auth;
  const authUnresolved = authPending || Boolean(authError);
  const accountOwner = useScoreDraftOwner('account', accountDraftSource(signedIn, authUnresolved));
  const [savedDraftOwner] = useState(() => storedScoreDraftOwner(planId));
  const { redeeming, matches } = guest;
  const guestOwner = useScoreDraftOwner(
    'guest',
    matches.isSuccess && matches.isFetchedAfterMount
      ? matches.data.reportingDraftOwnerId
      : undefined,
  );
  const preferRecoveredAccount =
    savedDraftOwner?.startsWith('account:') && guest.reportingPreference === undefined;
  const recoveredAccountPending = preferRecoveredAccount && accountOwner === undefined;
  const reportingPreference =
    guest.reportingPreference ??
    (recoveredAccountPending
      ? undefined
      : preferRecoveredAccount && accountOwner === savedDraftOwner
        ? 'signed-in'
        : 'guest');
  const setReportingPreference = (preference: 'guest' | 'signed-in') => {
    clearScoreDrafts(planId);
    guest.setReportingPreference(preference);
  };
  const signedReports = useQuery({
    queryKey: ['eventOpsReports', planId, signedIn?.user.id, signedIn?.session.id],
    queryFn: () => trpc.eventOps.myReports.query({ planId }),
    enabled: Boolean(signedIn),
    refetchInterval: 2500,
    retry: false,
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
    reportingPreference,
  );
  const signedReportingDenied = eventUnavailable(signedReports.error);
  const canWrite =
    online &&
    playOpen &&
    !publicEvent.isError &&
    Boolean(reporter) &&
    (reporter === 'guest' ? guestCredential : signedCredential && !signedReportingDenied) &&
    !redeeming &&
    !['complete', 'cancelled'].includes(data?.plan.status ?? '');
  const ownReports =
    reporter === 'guest'
      ? matches.data?.reports
      : reporter === 'signed-in' && !signedReportingDenied
        ? signedReports.data
        : undefined;
  const closed = data !== undefined && ['complete', 'cancelled'].includes(data.plan.status);
  const verifiedDraftOwner = (() => {
    if (closed || unpublished) return null;
    if (
      redeeming ||
      !data ||
      !publicEvent.isSuccess ||
      !publicEvent.isFetchedAfterMount ||
      recoveredAccountPending
    )
      return undefined;
    if (reporter === 'guest') {
      if (!guest.valid || guest.accessDenied) return null;
      return guestCredential ? guestOwner : undefined;
    }
    if (reporter === 'signed-in') {
      if (signedReportingDenied) return null;
      return signedReports.isSuccess && signedReports.isFetchedAfterMount
        ? accountOwner
        : undefined;
    }
    return authUnresolved ? undefined : null;
  })();
  const draftRecovery = useCallback(
    (match: PoolFlowMatch, attemptedRequestId: string | null): ScoreDraftRecovery => {
      if (
        attemptedRequestId !== null &&
        ownReports?.some(
          (item) => item.matchId === match.id && item.requestId === attemptedRequestId,
        )
      )
        return 'settled';
      if (
        !matchPresentation(match).canReport ||
        (match.status === 'complete' && scoreApprovalPolicy(data, match) === 'review')
      )
        return 'unavailable';
      const report = ownReports?.find((item) => item.matchId === match.id);
      return report?.status === 'pending' ||
        (match.status !== 'complete' && report?.status === 'approved')
        ? 'blocked-by-report'
        : 'available';
    },
    [data, ownReports],
  );
  const scoreDrafts = useScoreReportDrafts(
    JSON.stringify([planId, reportingIdentity, closed]),
    data?.matches,
    {
      planId,
      owner: verifiedDraftOwner && (!playOpen || !online) ? undefined : verifiedDraftOwner,
      recovery: draftRecovery,
    },
  );
  return {
    data,
    unpublished,
    playOpen,
    closed,
    guestCredential,
    signedCredential,
    reporter,
    reportingIdentity,
    canWrite,
    ownReports,
    scoreDrafts,
    setReportingPreference,
  };
}

function reportingAccess(
  guest: ReturnType<typeof useGuestEventAccess>,
  signedIn: Session,
  data: Awaited<ReturnType<typeof trpc.eventOps.snapshot.query>> | undefined,
  reportingPreference: 'guest' | 'signed-in' | undefined,
) {
  const { valid, redeeming, matches, session, cacheId, passVersion } = guest;
  const guestCredential = valid && !redeeming && Boolean(matches.data) && !matches.isError;
  const signedCredential = Boolean(signedIn) && Boolean(data?.settings.playerReports);
  // A polling outage or revocation disables the chosen pass without silently changing attribution.
  const reporter = !reportingPreference
    ? null
    : session && reportingPreference === 'guest'
      ? 'guest'
      : signedCredential
        ? 'signed-in'
        : null;
  const reportingIdentity =
    reporter === 'guest'
      ? `guest:${cacheId}:${passVersion}`
      : reporter === 'signed-in'
        ? `account:${signedIn!.user.id}:${signedIn!.session.id}`
        : 'anonymous';
  return { guestCredential, signedCredential, reporter, reportingIdentity };
}
