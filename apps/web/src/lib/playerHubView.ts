import type { NativeBracketView } from '../components/EventNightBoard';
import type { LiveMatch } from './eventDisplay';
import { includesPlayer } from './playerMatchView';
import { isUuidPlayerId } from './playerSelection';
import { isNativeRoundRobin } from './eventBracket';
import { matchesPool, poolKey, type PoolFlowData, type PoolFlowMatch } from './poolFlow';

export type HubBoardSection = 'brackets' | 'pools' | 'results';
type HubData = PoolFlowData & {
  plan: PoolFlowData['plan'] & { structure?: string; historicalResultsSlug?: string | null };
  nativeBrackets?: NativeBracketView[];
  brackets?: { division: string; stage: string; slug: string | null }[];
  entrants?: { id: string; name: string; memberPlayerIds?: string[] }[];
};

type PreviewEvent = {
  plan: {
    competitionFormat?: string | null;
    bracketMode?: string;
    liveOwned?: boolean;
    historicalResultsSlug?: string | null;
  };
  entrants: { id: string; name: string; memberPlayerIds?: string[] }[];
  memberNames?: Record<string, string>;
};

export type MatchPlayerPreview = (match: LiveMatch, side: 0 | 1) => boolean;

function isSinglesMember(id: string, members?: readonly string[]) {
  return !members || (members.length === 1 && members[0] === id);
}

function recordedSinglesPreview(entrants: PreviewEvent['entrants']): MatchPlayerPreview {
  const names = new Map(
    entrants
      .filter(({ id, name, memberPlayerIds }) =>
        Boolean(
          isUuidPlayerId(id) &&
          name.trim() &&
          name !== 'Player' &&
          isSinglesMember(id, memberPlayerIds),
        ),
      )
      .map(({ id, name }) => [id, name]),
  );
  return (match, side) => {
    if (
      match.status !== 'complete' ||
      match.outcome !== 'played' ||
      match.sourceSetId != null ||
      !match.winnerId ||
      match.score1 == null ||
      match.score2 == null
    )
      return false;
    const id = side === 0 ? match.player1Id : match.player2Id;
    const name = side === 0 ? match.player1Name : match.player2Name;
    const members = side === 0 ? match.player1MemberIds : match.player2MemberIds;
    // Act projects the match names and roster from the same public identities.
    return Boolean(id && name && isSinglesMember(id, members) && names.get(id) === name);
  };
}

export function publicEventProfilePreviews(data: PreviewEvent, recordedOnly: boolean) {
  const { competitionFormat, bracketMode, liveOwned, historicalResultsSlug } = data.plan;
  const showPlayerPreviews = competitionFormat === 'singles' && !recordedOnly;
  let canPreviewMatchPlayer: MatchPlayerPreview | undefined;
  if (showPlayerPreviews) canPreviewMatchPlayer = () => true;
  else if (
    recordedOnly &&
    competitionFormat === 'singles' &&
    bracketMode === 'native' &&
    liveOwned === true &&
    !historicalResultsSlug
  )
    canPreviewMatchPlayer = recordedSinglesPreview(data.entrants);

  return {
    showPlayerPreviews,
    canPreviewMatchPlayer,
    profileMemberNames: competitionFormat === 'doubles' ? data.memberNames : undefined,
  };
}

export function resolveHubPlayer(
  players: readonly { id: string }[],
  selected: string,
  entrants: readonly { id: string; memberPlayerIds?: string[] }[] = [],
) {
  if (players.some((item) => item.id === selected)) return selected;
  const team = entrants.find((entrant) => entrant.memberPlayerIds?.includes(selected));
  return team && players.some((item) => item.id === team.id) ? team.id : '';
}

/** Keep the preference so a temporarily absent player can reappear on the next public poll. */
export function effectivePlayerView(
  preferred: string | undefined,
  player: string,
  selected?: string,
) {
  const view = preferred ?? (selected || player ? 'mine' : 'queue');
  return view === 'mine' && !player ? 'matches' : view;
}

export function playerMatchProgress(matches: PoolFlowMatch[], closed: boolean) {
  return {
    completed: matches.filter((match) => match.status === 'complete').length,
    nextMatch: closed
      ? undefined
      : (matches.find((match) => match.status === 'playing') ??
        matches.find((match) => match.status === 'ready' && match.player1Id && match.player2Id)),
    waitingMatch: closed ? undefined : matches.find((match) => match.status !== 'complete'),
  };
}

/** Derive browsing only from public facts; a resolved pool never publishes a future seed. */
export function playerHubView(data: HubData, player = '', selectedPool = '') {
  const identities = new Set(player ? [player] : []);
  for (const entrant of data.entrants ?? [])
    if (entrant.id === player || entrant.memberPlayerIds?.includes(player))
      identities.add(entrant.id);
  const ownMatches = data.matches.filter((match) => player && includesPlayer(match, player));
  for (const match of ownMatches) {
    if (match.player1Id === player || match.player1MemberIds?.includes(player))
      if (match.player1Id) identities.add(match.player1Id);
    if (match.player2Id === player || match.player2MemberIds?.includes(player))
      if (match.player2Id) identities.add(match.player2Id);
  }
  const ownPools = new Set(ownMatches.map(poolKey).filter((key) => key !== null));
  const pools = data.matches.filter(
    (match) =>
      match.stage === 'group' &&
      matchesPool(match, selectedPool) &&
      (!player || ownPools.has(poolKey(match) ?? '')),
  );
  const eliminationBrackets = isNativeRoundRobin(data.plan) ? [] : (data.nativeBrackets ?? []);
  const assignedBrackets = eliminationBrackets.filter(
    (bracket) =>
      bracket.entrantIds.some((id) => identities.has(id)) ||
      ownMatches.some((match) => match.nativeBracketId === bracket.id),
  );
  const pendingBrackets =
    player && !assignedBrackets.length
      ? eliminationBrackets.filter((bracket) =>
          bracket.qualifierSlots?.some(
            (slot) =>
              slot.status !== 'resolved' &&
              (slot.candidateEntrantIds ?? slot.eligibleEntrantIds).some((id) =>
                identities.has(id),
              ),
          ),
        )
      : [];
  const nativeBrackets = player
    ? eliminationBrackets.filter(
        (bracket) => assignedBrackets.includes(bracket) || pendingBrackets.includes(bracket),
      )
    : eliminationBrackets;
  const divisions = new Set(ownMatches.map((match) => match.division));
  // Historical adoption keeps the saved plan bracket mode.
  const linked =
    data.plan.bracketMode === 'native' && !data.plan.historicalResultsSlug
      ? []
      : (data.brackets ?? []).filter((bracket) => !player || divisions.has(bracket.division));
  const bracketIds = new Set(assignedBrackets.map((bracket) => bracket.id));
  const bracketMatches = data.matches.filter((match) =>
    player
      ? Boolean(match.nativeBracketId && bracketIds.has(match.nativeBracketId))
      : match.stage !== 'group',
  );
  const allPools = data.matches.filter((match) => match.stage === 'group');
  const closed = ['complete', 'cancelled'].includes(data.plan.status);
  const activePools = !closed && allPools.some((match) => match.status !== 'complete');
  const activeBrackets =
    !closed && bracketMatches.some((match) => ['ready', 'playing'].includes(match.status));
  const resolvedPools = pools.length > 0 && pools.every((match) => match.status === 'complete');
  const hasBrackets = nativeBrackets.length > 0 || linked.some((item) => item.slug);
  const bracketsFirst = hasBrackets && (closed || activeBrackets || resolvedPools || !pools.length);
  const sections: HubBoardSection[] =
    data.plan.structure === 'round_robin' && resolvedPools
      ? ['results', 'pools', 'brackets']
      : closed
        ? hasBrackets
          ? ['brackets', 'results', 'pools']
          : ['results', 'pools', 'brackets']
        : resolvedPools && !hasBrackets
          ? ['results', 'brackets', 'pools']
          : bracketsFirst
            ? ['brackets', 'pools', 'results']
            : ['pools', 'brackets', 'results'];
  const results = data.matches.filter(
    (match) =>
      match.status === 'complete' &&
      // A printed pool filter must not hide a selected player's finals history.
      (player ? includesPlayer(match, player) : matchesPool(match, selectedPool)),
  );
  return {
    identities,
    ownPools,
    pools,
    nativeBrackets,
    assignedBrackets,
    pendingBrackets,
    linked,
    hasBrackets,
    sections:
      closed && !allPools.length ? sections.filter((section) => section !== 'pools') : sections,
    results,
    activePools,
    activeBrackets,
    resolvedPools,
    closed,
  };
}

/** Compact path retains original feeder labels; conditional rounds are never assigned opponents. */
export function playerBracketPath(matches: PoolFlowMatch[], player: string) {
  const path = new Set(
    matches.filter((match) => includesPlayer(match, player)).map((match) => match.id),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const match of matches) {
      if (path.has(match.id) || match.status === 'complete') continue;
      const reachable = ([1, 2] as const).some((side) => {
        const parentId = side === 1 ? match.parent1MatchId : match.parent2MatchId;
        if (!parentId || !path.has(parentId)) return false;
        const parent = matches.find((item) => item.id === parentId);
        if (!parent || parent.status !== 'complete') return true;
        const outcome = (side === 1 ? match.parent1Outcome : match.parent2Outcome) ?? 'winner';
        const entrant =
          outcome === 'winner'
            ? parent.winnerId
            : parent.winnerId && parent.player1Id && parent.player2Id
              ? parent.winnerId === parent.player1Id
                ? parent.player2Id
                : parent.player1Id
              : null;
        return Boolean(
          entrant &&
          includesPlayer(parent, player) &&
          (entrant === player ||
            (entrant === parent.player1Id
              ? parent.player1MemberIds
              : parent.player2MemberIds
            )?.includes(player)),
        );
      });
      if (reachable) {
        path.add(match.id);
        changed = true;
      }
    }
  }
  return matches.filter((match) => path.has(match.id));
}

export function recentPlayerMatches<T extends PoolFlowMatch & { resultUpdatedAt?: string | null }>(
  matches: T[],
  limit = 3,
  reportedIds: ReadonlySet<string> = new Set(),
): T[] {
  const history = matches
    .map((match, index) => ({ match, index }))
    .filter(({ match }) => match.status === 'complete')
    .sort(
      (a, b) =>
        (Date.parse(b.match.resultUpdatedAt ?? '') || 0) -
          (Date.parse(a.match.resultUpdatedAt ?? '') || 0) || b.index - a.index,
    );
  const recent = new Set(history.slice(0, limit).map(({ match }) => match.id));
  return matches.filter(
    (match) => match.status !== 'complete' || recent.has(match.id) || reportedIds.has(match.id),
  );
}
