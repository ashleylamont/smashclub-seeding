import { hash, requireFact, resolved, stableId } from './facts';
import { advance } from './brackets';
import type { CommandEnvelope, TournamentState } from './schemas';

type Input = Extract<CommandEnvelope['command'], { kind: 'attendance' }>;
export function attendancePreview(
  state: TournamentState,
  input: Omit<Input, 'kind' | 'revisionToken' | 'entrant' | 'reason' | 'approveRedistribution'> & {
    approveRedistribution?: boolean;
  },
) {
  const entrant = state.entrants.find((e) => e.playerId === input.playerId);
  const division = input.division ?? entrant?.division ?? 'lower';
  const protectedPool = (id: string) =>
    state.matches.some(
      (m) =>
        m.poolId === id &&
        (m.started || resolved(m) || state.reports.some((r) => r.matchId === m.id)),
    );
  const open = state.pools
    .filter((p) => p.division === division && !protectedPool(p.id) && p.entrantIds.length < 5)
    .sort((a, b) => a.entrantIds.length - b.entrantIds.length || a.index - b.index);
  const pool =
    input.action === 'add'
      ? open[0]
      : state.pools.find((p) => p.entrantIds.includes(input.playerId));
  const issues: string[] = [];
  if (!['locked', 'unlocked'].includes(state.lifecycle))
    issues.push('Attendance changes require an open locked event.');
  if (input.action !== 'withdraw' && state.brackets.length)
    issues.push('Remove unplayed finals before changing the pool draw.');
  if (input.action === 'add' ? entrant : !entrant)
    issues.push(
      input.action === 'add'
        ? 'This player is already in the event.'
        : 'This player is not attending.',
    );
  if (!pool) issues.push('No eligible pool is available.');
  if (input.action === 'add' && input.poolIndex !== undefined && input.poolIndex !== pool?.index)
    issues.push('The smallest open pool changed.');
  const involved = state.matches.filter((m) => [m.player1Id, m.player2Id].includes(input.playerId));
  if (
    input.action === 'no_show' &&
    involved.some((m) => m.started || resolved(m) || state.reports.some((r) => r.matchId === m.id))
  )
    issues.push('This player has match history. Record a withdrawal.');
  const remaining =
    pool?.entrantIds.filter((id) => input.action !== 'no_show' || id !== input.playerId) ?? [];
  if (input.action === 'no_show' && remaining.length < 2)
    issues.push('A pool needs at least two players.');
  if (input.action === 'redistribute' && remaining.length !== 2)
    issues.push('Only a two-player pool can be redistributed.');
  const relocations: { playerId: string; fromPoolIndex: number; toPoolIndex: number }[] = [];
  if (
    pool &&
    remaining.length === 2 &&
    ['no_show', 'redistribute'].includes(input.action) &&
    !protectedPool(pool.id)
  ) {
    const targets = open.filter((p) => p.id !== pool.id);
    const together = targets.find((p) => p.entrantIds.length <= 3);
    const destinations = together ? [together, together] : targets.slice(0, 2);
    if (destinations.length === 2)
      remaining.forEach((playerId, i) =>
        relocations.push({
          playerId,
          fromPoolIndex: pool.index,
          toPoolIndex: destinations[i]!.index,
        }),
      );
  }
  if (input.action === 'redistribute' && !relocations.length)
    issues.push('No safe redistribution is available.');
  return {
    allowed: !issues.length,
    issues,
    warnings:
      input.action === 'withdraw'
        ? ['Played results are retained; remaining pool pairings await explicit forfeit decisions.']
        : [],
    requiresExternalAcknowledgement: false,
    requiresRedistributionApproval: Boolean(relocations.length),
    relocations,
    division,
    poolIndex: pool?.index ?? null,
    poolSize: pool?.entrantIds.length ?? 0,
    addedMatches: input.action === 'add' ? (pool?.entrantIds.length ?? 0) : 0,
    affectedMatches: involved.map((m) => ({ id: m.id, label: m.label, status: m.status })),
    revisionToken: hash({
      entrants: state.entrants,
      pools: state.pools,
      matches: state.matches,
      reports: state.reports,
      brackets: state.brackets,
      lifecycle: state.lifecycle,
    }),
  };
}

export function applyAttendance(state: TournamentState, envelope: CommandEnvelope, input: Input) {
  const preview = attendancePreview(state, input);
  requireFact(
    preview.revisionToken === input.revisionToken,
    'The event changed since this preview. Review the updated attendance change.',
  );
  requireFact(preview.allowed, preview.issues.join(' '));
  const pool = state.pools.find(
    (p) => p.division === preview.division && p.index === preview.poolIndex,
  )!;
  if (input.action === 'withdraw') {
    const entrant = state.entrants.find((e) => e.playerId === input.playerId)!;
    entrant.availability = 'withdrawn';
    entrant.revision++;
    for (const m of state.matches.filter(
      (m) => m.status === 'playing' && [m.player1Id, m.player2Id].includes(input.playerId),
    )) {
      m.status = 'blocked';
      m.stationId = null;
      m.blockedReason = 'Player withdrawn: awaiting organiser forfeit decision';
    }
    pool.order = null;
    pool.revision++;
    advance(state, envelope.at, envelope.id);
  } else {
    const touched = new Set([pool.id]);
    if (input.action === 'add') {
      requireFact(input.entrant, 'Capture the new entrant identity first.');
      state.entrants.push({
        ...input.entrant,
        playerId: input.playerId,
        division: preview.division,
        seed:
          Math.max(
            0,
            ...state.entrants.filter((e) => e.division === preview.division).map((e) => e.seed),
          ) + 1,
        availability: 'available',
        revision: 0,
      });
      pool.entrantIds.push(input.playerId);
    } else {
      if (input.action === 'redistribute')
        requireFact(input.approveRedistribution, 'Approve the proposed moves first.');
      if (input.action === 'no_show') {
        state.entrants = state.entrants.filter((e) => e.playerId !== input.playerId);
        pool.entrantIds = pool.entrantIds.filter((id) => id !== input.playerId);
        state.matches = state.matches.filter(
          (m) => ![m.player1Id, m.player2Id].includes(input.playerId),
        );
      }
      if (input.approveRedistribution)
        for (const move of preview.relocations) {
          const target = state.pools.find(
            (p) => p.division === preview.division && p.index === move.toPoolIndex,
          )!;
          touched.add(target.id);
          target.entrantIds.push(move.playerId);
          pool.entrantIds = pool.entrantIds.filter((id) => id !== move.playerId);
        }
    }
    for (const changed of state.pools.filter((p) => touched.has(p.id))) {
      changed.order = null;
      changed.revision++;
      // Preserve all unrelated actual pairings; only removed unplayed pairs disappear.
      state.matches = state.matches.filter(
        (m) =>
          m.poolId !== changed.id ||
          (changed.entrantIds.includes(m.player1Id!) && changed.entrantIds.includes(m.player2Id!)),
      );
      for (let a = 0; a < changed.entrantIds.length; a++)
        for (let b = a + 1; b < changed.entrantIds.length; b++) {
          const p1 = changed.entrantIds[a]!,
            p2 = changed.entrantIds[b]!;
          if (
            state.matches.some(
              (m) =>
                m.poolId === changed.id &&
                [m.player1Id, m.player2Id].includes(p1) &&
                [m.player1Id, m.player2Id].includes(p2),
            )
          )
            continue;
          const id = stableId(`${envelope.id}:${changed.id}:${p1}:${p2}`);
          state.matches.push({
            id,
            sourceKey: id,
            division: changed.division,
            stage: 'group',
            poolId: changed.id,
            bracketId: null,
            round: 0,
            slot: state.matches.length,
            label: `${changed.division} pool ${changed.index + 1}`,
            parent1Id: null,
            parent2Id: null,
            player1Id: p1,
            player2Id: p2,
            status: 'ready',
            outcome: null,
            score1: null,
            score2: null,
            winnerId: null,
            stationId: null,
            revision: 0,
            started: false,
            completedAt: null,
            automaticFromRevision: null,
            resultCommandId: null,
            liveScore1: null,
            liveScore2: null,
            progressRevision: 0,
            blockedReason: null,
          });
        }
    }
    state.pools = state.pools.filter((p) => p.entrantIds.length);
  }
  state.settings.resourceRevision++;
}
