import { publicPlayerName } from '@smashclub/shared';
import { requireFact } from './facts';
import { advance } from './brackets';
import {
  hasFixedLegacyPoolQualifiers,
  hasLegacyQualifier,
  legacyPendingRosterMessage,
} from './legacyFinalQualifiers';
import type { CommandEnvelope, TournamentCommand, TournamentState } from './schemas';

export type Entrant = TournamentState['entrants'][number];
export const livePairNameRevision = (entrant: Entrant) => `live:${entrant.revision}`;
export const memberIds = (e: Entrant): string[] => e.memberPlayerIds ?? [e.playerId];
export const available = (e: Entrant) =>
  e.availability === 'available' &&
  memberIds(e).every((id) => (e.memberAvailability?.[id] ?? 'available') === 'available');
export function matchMemberIds(
  state: TournamentState,
  match: TournamentState['matches'][number],
): string[] {
  return state.entrants
    .filter((e) => [match.player1Id, match.player2Id].includes(e.playerId))
    .flatMap(memberIds);
}

export function renameDoublesPair(
  next: TournamentState,
  command: Extract<TournamentCommand, { kind: 'renameDoublesPair' }>,
  basis: Record<string, number>,
) {
  const entrant = next.entrants.find((entry) => entry.id === command.entrantId);
  requireFact(
    next.baseline?.competitionFormat === 'doubles' && entrant?.memberPlayerIds?.length === 2,
    'Choose an existing doubles pair.',
  );
  requireFact(
    livePairNameRevision(entrant) === command.expectedRevision,
    'The pair changed. Review its current details before saving.',
  );
  basis[entrant.id] = entrant.revision;
  if ((entrant.teamName ?? null) === command.teamName) return;
  entrant.teamName = command.teamName;
  entrant.revision++;
}

export function changeAvailability(
  next: TournamentState,
  envelope: CommandEnvelope,
  command: Extract<TournamentCommand, { kind: 'availability' }>,
  basis: Record<string, number>,
) {
  const entrant = next.entrants.find(
    (e) => e.playerId === command.playerId || memberIds(e).includes(command.playerId),
  );
  requireFact(entrant && entrant.revision === command.expectedRevision, 'Entrant changed.');
  requireFact(
    !next.matches.some(
      (m) => m.status === 'playing' && [m.player1Id, m.player2Id].includes(entrant.playerId),
    ),
    'Resolve their playing match first.',
  );
  basis[entrant.id] = entrant.revision;
  if (command.playerId !== entrant.playerId) {
    requireFact(
      command.availability !== 'withdrawn',
      'Withdraw the pair explicitly; a member can be available or snoozed.',
    );
    entrant.memberAvailability = {
      ...entrant.memberAvailability,
      [command.playerId]: command.availability,
    };
  } else {
    const changesEligibility =
      (entrant.availability === 'withdrawn') !== (command.availability === 'withdrawn');
    if (changesEligibility) {
      const pool = next.pools.find((p) => p.entrantIds.includes(entrant.playerId));
      requireFact(
        !pool || !hasLegacyQualifier(next, pool.id, 'pending'),
        legacyPendingRosterMessage,
      );
    }
    entrant.availability = command.availability;
  }
  entrant.revision++;
  if (
    command.availability === 'withdrawn' &&
    (!next.settings.poolOrderPolicy || !next.brackets.length)
  )
    for (const pool of next.pools.filter((p) => p.entrantIds.includes(entrant.playerId))) {
      if (hasFixedLegacyPoolQualifiers(next, pool)) continue;
      pool.order = null;
      pool.revision++;
    }
  next.settings.resourceRevision++;
  advance(next, envelope.at, envelope.id);
}

export function publicEntrantNames(
  profiles: readonly { id: string; canonicalName: string; displayName: string | null }[],
  entrants: readonly Entrant[],
) {
  const names = new Map(profiles.map((p) => [p.id, publicPlayerName(p)]));
  for (const e of entrants)
    if (e.memberPlayerIds)
      names.set(
        e.playerId,
        publicEntrantName(e, (id) => names.get(id)),
      );
  return names;
}

export function publicEntrantName(e: Entrant, playerName: (id: string) => string | undefined) {
  const members = memberIds(e)
    .map((id) => playerName(id) ?? 'Player')
    .join(' / ');
  return e.teamName ? `${e.teamName} (${members})` : members;
}
export type MemberView = {
  entrantId: string;
  playerId: string;
  name: string;
  availability: 'available' | 'snoozed';
  revision: number;
};

export function eventMemberViews(
  entrants: readonly Entrant[],
  names: ReadonlyMap<string, string>,
): MemberView[] {
  return entrants.flatMap((entrant) =>
    memberIds(entrant).map((id) => ({
      entrantId: entrant.playerId,
      playerId: id,
      name: names.get(id) ?? 'Player',
      availability: entrant.memberAvailability?.[id] ?? 'available',
      revision: entrant.revision,
    })),
  );
}
