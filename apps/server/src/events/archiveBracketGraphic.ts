import {
  eventPlans,
  nativeResultPublications,
  type Db,
  type sets,
  type tournaments,
} from '@smashclub/db';
import { eventNameOf, gamesIndicateUnplayed } from '@smashclub/shared';
import {
  buildDoubleEliminationTree,
  buildEliminationTree,
  type TournamentSlot,
} from '@smashclub/tournament-formats';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { matchNames } from '../tournament/matchNames';
import { hasSupersededAdvancement } from '../tournament/resultEvidence';
import { Result, type Match, type TournamentResult } from '../tournament/schemas';
import { legacyNativeArchiveDraw } from './legacyNativeArchiveDraw';

type ArchivedSet = typeof sets.$inferSelect;
type ArchivedTournament = typeof tournaments.$inferSelect;
type DrawBracket = TournamentResult['brackets'][number];
type DrawMatch = NonNullable<
  Awaited<ReturnType<typeof legacyNativeArchiveDraw>>
>['matches'][number] & {
  lane?: Match['bracketLane'];
  bracketRound?: number;
  parent1Outcome?: Match['parent1Outcome'];
  parent2Outcome?: Match['parent2Outcome'];
};
const resultRef = z.object({
  provider: z.literal('native'),
  eventPlanId: z.uuid(),
  resultId: z.uuid(),
  resultRevision: z.number().int().positive(),
  division: z.enum(['upper', 'lower']),
  stage: z.enum(['main', 'consolation']),
});
const setRef = z.object({
  provider: z.literal('native'),
  resultId: z.uuid(),
  resultRevision: z.number().int().positive(),
  eventMatchId: z.uuid(),
});

async function readPublishedDraw(
  db: Db,
  tournament: ArchivedTournament,
  finals: readonly ArchivedSet[],
) {
  const ref = resultRef.safeParse(tournament.raw);
  if (!ref.success) return undefined;
  const { resultId, resultRevision, eventPlanId, division, stage } = ref.data;
  const [receipt] = await db
    .select({
      result: nativeResultPublications.result,
      tournamentIds: nativeResultPublications.tournamentIds,
    })
    .from(nativeResultPublications)
    .innerJoin(eventPlans, eq(eventPlans.id, nativeResultPublications.eventPlanId))
    .where(
      and(
        eq(nativeResultPublications.resultId, resultId),
        eq(nativeResultPublications.revision, resultRevision),
        eq(nativeResultPublications.eventPlanId, eventPlanId),
        isNull(eventPlans.resultsWithdrawnAt),
      ),
    );
  if (!receipt?.tournamentIds.includes(tournament.id)) return undefined;
  const parsed = Result.safeParse(receipt.result);
  if (!parsed.success) return undefined;
  const result = parsed.data;
  if (
    result.id !== resultId ||
    result.revision !== resultRevision ||
    result.planId !== eventPlanId ||
    result.structure === 'round_robin' ||
    (result.competitionFormat ?? 'singles') !== tournament.competitionFormat
  )
    return undefined;
  const brackets = result.brackets.filter((b) => b.division === division && b.stage === stage);
  if (brackets.length !== 1) return undefined;
  const bracket = brackets[0]!;
  const matches = result.matches.filter((m) => m.bracketId === bracket.id);
  if (!verifiedPublishedTopology(bracket, matches, result.structure === 'double_elimination'))
    return undefined;

  const active = matches.filter((m) => !m.skipped);
  if (active.length !== finals.length) return undefined;
  const byMatch = new Map<string, ArchivedSet>();
  for (const row of finals) {
    const parsedRef = setRef.safeParse(row.raw);
    if (!parsedRef.success) return undefined;
    const source = parsedRef.data;
    if (
      source.resultId !== resultId ||
      source.resultRevision !== resultRevision ||
      byMatch.has(source.eventMatchId)
    )
      return undefined;
    byMatch.set(source.eventMatchId, row);
  }
  const labels = matchNames(result);
  const nodes: DrawMatch[] = [];
  const participantByEntrant = new Map<string, string>();
  const entrantByParticipant = new Map<string, string>();
  function verifyParticipant(entrant: string | null, participant: string | null) {
    if (!entrant || !participant) return entrant === null && participant === null;
    if (participantByEntrant.has(entrant)) return participantByEntrant.get(entrant) === participant;
    if (entrantByParticipant.has(participant)) return false;
    participantByEntrant.set(entrant, participant);
    entrantByParticipant.set(participant, entrant);
    return true;
  }
  for (const match of active) {
    const row = byMatch.get(match.id);
    const fact = row && archivedFact(row);
    const round = match.bracketRound ?? match.round;
    const winner = match.winnerId === null ? null : match.winnerId === match.player1Id ? 1 : 2;
    if (
      !row ||
      !fact ||
      match.status !== 'complete' ||
      (match.winnerId &&
        match.winnerId !== match.player1Id &&
        match.winnerId !== match.player2Id) ||
      row.round !== (match.bracketLane === 'losers' ? -round : round) ||
      row.winner !== winner ||
      fact.outcome !== match.outcome ||
      fact.score1 !== match.score1 ||
      fact.score2 !== match.score2 ||
      !verifyParticipant(match.player1Id, row.p1ParticipantId) ||
      !verifyParticipant(match.player2Id, row.p2ParticipantId)
    )
      return undefined;
    nodes.push({
      id: match.id,
      setId: row.id,
      label: labels.get(match.id)!,
      round: match.round,
      slot: match.slot,
      lane: match.bracketLane,
      bracketRound: match.bracketRound,
      parent1: match.parent1Id,
      parent2: match.parent2Id,
      parent1Outcome: match.parent1Outcome,
      parent2Outcome: match.parent2Outcome,
    });
  }
  return {
    eventName: result.name,
    revision: resultRevision,
    open: Boolean(result.structure && result.structure !== 'dual_division'),
    division,
    stage,
    matches: nodes,
  };
}

/** Compare slot and feeder positions for completeness. The export always uses
 * the stored matches and links, including replacements with different IDs. */
function verifiedPublishedTopology(bracket: DrawBracket, matches: Match[], double: boolean) {
  const size = bracket.qualifierSlots?.length ?? bracket.entrantIds.length;
  if (size < 1 || size > 512) return false;
  const slots = Array.from({ length: size }, (): TournamentSlot => ({ kind: 'bye' }));
  const build = double ? buildDoubleEliminationTree : buildEliminationTree;
  const expected = build(bracket.id, slots);
  const byPosition = new Map(matches.map((m) => [`${m.round}:${m.slot}`, m]));
  const byTemplate = new Map(expected.map((m) => [m.id, byPosition.get(`${m.round}:${m.slot}`)]));
  return (
    matches.length === expected.length &&
    new Set(matches.map((m) => m.id)).size === matches.length &&
    expected.every((node) => {
      const match = byTemplate.get(node.id);
      if (
        !match ||
        match.division !== bracket.division ||
        match.stage !== bracket.stage ||
        match.bracketLane !== node.bracketLane ||
        match.bracketRound !== node.bracketRound
      )
        return false;
      const feeds = node.sides.map((side) =>
        side.kind === 'winner' || side.kind === 'loser'
          ? { id: byTemplate.get(side.matchId)?.id, outcome: side.kind }
          : { id: null, outcome: 'winner' },
      );
      if (
        match.parent1Id !== feeds[0]!.id ||
        match.parent2Id !== feeds[1]!.id ||
        (match.parent1Outcome ?? 'winner') !== feeds[0]!.outcome ||
        (match.parent2Outcome ?? 'winner') !== feeds[1]!.outcome
      )
        return false;
      if (!node.activation) return !match.activation && !match.skipped;
      const parent = byTemplate.get(node.activation.matchId);
      if (
        !parent ||
        match.activation?.matchId !== parent.id ||
        match.activation.winnerSide !== node.activation.winnerSide
      )
        return false;
      const requiredWinner = node.activation.winnerSide === 1 ? parent.player1Id : parent.player2Id;
      return Boolean(match.skipped) === (!requiredWinner || parent.winnerId !== requiredWinner);
    })
  );
}

function archivedFact(row: ArchivedSet, legacyNoContest?: true) {
  const raw = row.raw as { outcome?: unknown } | null;
  // Legacy finalization copied its null outcome. Its verified match link
  // can supply the reason, while the archived row still supplies the result.
  const outcome = raw?.outcome === null && legacyNoContest ? 'no_contest' : raw?.outcome;
  const { p1ParticipantId: first, p2ParticipantId: second, winner, scoresCsv } = row;
  if (
    row.state !== 'complete' ||
    (first !== null && first === second) ||
    (winner !== null && !((winner === 1 && first) || (winner === 2 && second)))
  )
    return undefined;
  if (outcome === 'played') {
    const score = scoresCsv?.match(/^(\d+)-(\d+)$/);
    if (!first || !second || !score) return undefined;
    const score1 = Number(score[1]);
    const score2 = Number(score[2]);
    if (
      gamesIndicateUnplayed(score1, score2) ||
      winner !== (score1 > score2 ? 1 : score2 > score1 ? 2 : null) ||
      winner === null
    )
      return undefined;
    return { outcome, score1, score2 };
  }
  if (
    scoresCsv !== null ||
    !(
      (outcome === 'no_contest' && winner === null) ||
      (outcome === 'forfeit' && winner !== null) ||
      (outcome === 'bye' && winner !== null && (!first || !second))
    )
  )
    return undefined;
  return { outcome, score1: null, score2: null };
}

function archiveMatches(
  tournamentId: string,
  stage: string,
  division: string,
  nodes: DrawMatch[],
  finals: readonly ArchivedSet[],
  names: ReadonlyMap<string, string>,
) {
  const bySet = new Map(finals.map((row) => [row.id, row]));
  const byNode = new Map(nodes.map((node) => [node.id, bySet.get(node.setId)!]));
  type FeedOutcome = DrawMatch['parent1Outcome'];
  const feedAgrees = (parent: string | null, outcome: FeedOutcome, participant: string | null) => {
    if (parent === null) return true;
    const row = byNode.get(parent);
    if (!row) return false;
    if (row.winner === null) return participant === null;
    const side = outcome === 'loser' ? (row.winner === 1 ? 2 : 1) : row.winner;
    return participant === (side === 1 ? row.p1ParticipantId : row.p2ParticipantId);
  };
  const matches = [];
  for (const node of nodes) {
    const row = bySet.get(node.setId)!;
    const fact = archivedFact(row, node.legacyNoContest);
    const player1Name = row.p1ParticipantId ? names.get(row.p1ParticipantId) : null;
    const player2Name = row.p2ParticipantId ? names.get(row.p2ParticipantId) : null;
    if (
      !fact ||
      player1Name === undefined ||
      player2Name === undefined ||
      !feedAgrees(node.parent1, node.parent1Outcome, row.p1ParticipantId) ||
      !feedAgrees(node.parent2, node.parent2Outcome, row.p2ParticipantId)
    )
      return undefined;
    matches.push({
      ...fact,
      id: row.id,
      label: node.label,
      nativeBracketId: tournamentId,
      nativeRound: node.round,
      nativeSlot: node.slot,
      bracketLane: node.lane,
      bracketRound: node.bracketRound,
      parent1MatchId: node.parent1 ? byNode.get(node.parent1)!.id : null,
      parent2MatchId: node.parent2 ? byNode.get(node.parent2)!.id : null,
      parent1Outcome: node.parent1Outcome,
      parent2Outcome: node.parent2Outcome,
      player1Id: row.p1ParticipantId,
      player2Id: row.p2ParticipantId,
      player1Name,
      player2Name,
      winnerId:
        row.winner === 1 ? row.p1ParticipantId : row.winner === 2 ? row.p2ParticipantId : null,
      status: 'complete',
      stage,
      division,
      poolIndex: null,
      stationId: null,
    });
  }
  return matches;
}

/** Resolve only the tournament's own published graph. Imported round numbers
 * and scores do not establish prerequisite IDs or advancement outcomes. */
export async function archivedBracketGraphic(
  db: Db,
  tournament: ArchivedTournament,
  sets: readonly ArchivedSet[],
  names: ReadonlyMap<string, string>,
) {
  const labels = new Map<string, string>();
  if (tournament.provider !== 'native' || tournament.challongeState !== 'complete')
    return { labels };
  const finals = sets.filter(
    (set) => set.resultStage === 'final' && !hasSupersededAdvancement(set.raw),
  );
  if (!finals.length || finals.length > 1023) return { labels };
  const legacy = await legacyNativeArchiveDraw(db, tournament, sets);
  for (const node of legacy?.matches ?? []) labels.set(node.setId, node.label);
  const draw = legacy
    ? { ...legacy, eventName: eventNameOf([tournament.name]), revision: undefined, open: false }
    : await readPublishedDraw(db, tournament, finals);
  if (!draw) return { labels };
  const matches = archiveMatches(
    tournament.id,
    draw.stage,
    draw.division,
    draw.matches,
    finals,
    names,
  );
  if (!matches) return { labels };
  const division = draw.open ? 'Open' : draw.division === 'upper' ? 'Upper' : 'Lower';
  return {
    labels,
    graphic: {
      eventName: draw.eventName,
      eventDate: tournament.eventDate?.toISOString() ?? null,
      format: tournament.competitionFormat,
      scope: `${division} ${draw.stage === 'main' ? 'championship' : 'consolation'}`,
      revision: draw.revision,
      matches,
    },
  };
}

export type ArchivedBracketGraphic = NonNullable<
  Awaited<ReturnType<typeof archivedBracketGraphic>>['graphic']
>;
