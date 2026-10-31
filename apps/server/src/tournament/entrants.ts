import { publicPlayerName } from '@smashclub/shared';
import { requireFact } from './facts';
import { advance } from './brackets';
import type { CommandEnvelope, TournamentCommand, TournamentState } from './schemas';

export type Entrant = TournamentState['entrants'][number];
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
  } else entrant.availability = command.availability;
  entrant.revision++;
  if (
    command.availability === 'withdrawn' &&
    (!next.settings.poolOrderPolicy || !next.brackets.length)
  )
    for (const pool of next.pools.filter((p) => p.entrantIds.includes(entrant.playerId))) {
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
        `${e.teamName ? `${e.teamName} (` : ''}${memberIds(e)
          .map((id) => names.get(id) ?? 'Player')
          .join(' / ')}${e.teamName ? ')' : ''}`,
      );
  return names;
}
export type MemberView = {
  entrantId: string;
  playerId: string;
  name: string;
  availability: 'available' | 'snoozed';
  revision: number;
};
