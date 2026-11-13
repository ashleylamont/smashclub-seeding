import {
  eventMatches,
  eventScoreReports,
  nativeResultPublications,
  players,
  type sets,
  tournamentParticipants,
  type Db,
} from '@smashclub/db';
import { parseScoresCsv } from '@smashclub/engine';
import { publicPlayerName, unplayedResultOutcome, type SetCharacterPick } from '@smashclub/shared';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { playerIdResolver } from '../identity/playerIds';
import { agreedCharacters, leadingCharacters } from '../players/characterEvidence';
import {
  lateCharacterReports,
  nativeCharacterEvidence,
  sameCharacterParticipants,
} from '../players/nativeCharacterEvidence';
import type { NativeRuntime } from '../tournament/runtime';
import { nativeHistory } from './nativeHistory';

export type ArchiveSet = Pick<
  typeof sets.$inferSelect,
  | 'id'
  | 'tournamentId'
  | 'state'
  | 'winner'
  | 'scoresCsv'
  | 'raw'
  | 'p1PlayerId'
  | 'p2PlayerId'
  | 'p1ParticipantId'
  | 'p2ParticipantId'
>;

const nativeRef = z.object({
  provider: z.literal('native'),
  eventMatchId: z.uuid(),
  resultId: z.uuid(),
});

export function isPlayedArchiveSet(set: ArchiveSet) {
  return (
    set.state === 'complete' &&
    (set.winner === 1 || set.winner === 2) &&
    !unplayedResultOutcome(set.scoresCsv, set.raw) &&
    !(
      set.raw &&
      typeof set.raw === 'object' &&
      'outcome' in set.raw &&
      set.raw.outcome === 'no_contest'
    ) &&
    Boolean(
      set.p1ParticipantId && set.p2ParticipantId && set.p1ParticipantId !== set.p2ParticipantId,
    )
  );
}

export async function archiveCharacterReferences(db: Db, rows: readonly ArchiveSet[]) {
  const refs = new Map(
    rows.flatMap((row) => {
      const ref = nativeRef.safeParse(row.raw);
      return ref.success ? [[row.id, ref.data] as const] : [];
    }),
  );
  const resultIds = [...new Set([...refs.values()].map((ref) => ref.resultId))];
  const publications = resultIds.length
    ? await db
        .select({
          id: nativeResultPublications.resultId,
          planId: nativeResultPublications.eventPlanId,
          tournamentIds: nativeResultPublications.tournamentIds,
        })
        .from(nativeResultPublications)
        .where(inArray(nativeResultPublications.resultId, resultIds))
    : [];
  const byResult = new Map(publications.map((publication) => [publication.id, publication]));
  return new Map(
    rows.flatMap((row) => {
      const ref = refs.get(row.id);
      const publication = ref && byResult.get(ref.resultId);
      return ref && publication?.tournamentIds.includes(row.tournamentId)
        ? [[row.id, { planId: publication.planId, matchId: ref.eventMatchId }] as const]
        : [];
    }),
  );
}

export async function archiveCharacterPlayers(db: Db, rows: readonly ArchiveSet[]) {
  const ids = [
    ...new Set(
      rows
        .flatMap((row) => [row.p1ParticipantId, row.p2ParticipantId])
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const participants = ids.length
    ? await db.select().from(tournamentParticipants).where(inArray(tournamentParticipants.id, ids))
    : [];
  const byId = new Map(participants.map((p) => [p.id, p]));
  const profiles = await db.select().from(players);
  const canonical = playerIdResolver(profiles);
  const names = new Map(profiles.map((player) => [player.id, publicPlayerName(player)]));
  const participantIds = (id: string | null, player: string | null, tournamentId: string) => {
    const participant = id && byId.get(id);
    if (!participant || participant.tournamentId !== tournamentId) return [];
    return (
      participant.memberPlayerIds ??
      [player ?? participant.playerId].filter((value): value is string => Boolean(value))
    );
  };
  const members = new Map(
    rows.map((row) => [
      row.id,
      [
        ...new Set(
          [
            ...participantIds(row.p1ParticipantId, row.p1PlayerId, row.tournamentId),
            ...participantIds(row.p2ParticipantId, row.p2PlayerId, row.tournamentId),
          ].map(canonical),
        ),
      ].map((id) => ({ id, name: names.get(id) ?? 'Player' })),
    ]),
  );
  return { members, canonical };
}

export async function archiveCharacterEvidence(
  db: Db,
  rows: readonly ArchiveSet[],
  runtime?: NativeRuntime,
) {
  if (!rows.length) return new Map<string, ArchivedCharacterSet>();
  const history = await nativeHistory(db);
  const played = rows.filter(
    (row) => isPlayedArchiveSet(row) && !history.superseded.has(row.tournamentId),
  );
  if (!played.length) return new Map<string, ArchivedCharacterSet>();
  const references = await archiveCharacterReferences(db, played);
  const { members, canonical } = await archiveCharacterPlayers(db, played);
  const archive = played.filter((row) => !references.has(row.id));
  const archiveIds = archive.map(({ id }) => id);
  const linked = archiveIds.length
    ? await db
        .select({
          id: eventMatches.sourceSetId,
          revision: eventMatches.revision,
          reportedRevision: eventScoreReports.expectedRevision,
          player1: eventMatches.player1Id,
          player2: eventMatches.player2Id,
          score1: eventScoreReports.score1,
          score2: eventScoreReports.score2,
          picks: eventScoreReports.characterPicks,
        })
        .from(eventMatches)
        .innerJoin(eventScoreReports, eq(eventScoreReports.matchId, eventMatches.id))
        .where(
          and(
            inArray(eventMatches.sourceSetId, archiveIds),
            eq(eventMatches.status, 'complete'),
            eq(eventMatches.outcome, 'played'),
            eq(eventScoreReports.status, 'approved'),
            eq(eventScoreReports.outcome, 'played'),
            isNotNull(eventScoreReports.characterPicks),
          ),
        )
    : [];
  const reports = new Map<string, SetCharacterPick[][]>();
  const add = (id: string, picks: SetCharacterPick[]) => {
    const values = reports.get(id) ?? [];
    values.push(picks.map((pick) => ({ ...pick, playerId: canonical(pick.playerId) })));
    reports.set(id, values);
  };
  const byId = new Map(played.map((row) => [row.id, row]));
  for (const report of linked) {
    const row = byId.get(report.id!)!;
    if (report.reportedRevision < report.revision - 1 || report.reportedRevision > report.revision)
      continue;
    if (!report.player1 || !report.player2 || !row.p1PlayerId || !row.p2PlayerId) continue;
    const score = parseScoresCsv(row.scoresCsv);
    const first = canonical(row.p1PlayerId);
    const second = canonical(row.p2PlayerId);
    const p1 = canonical(report.player1);
    const p2 = canonical(report.player2);
    if (
      !score.unknown &&
      ((p1 === first &&
        p2 === second &&
        score.p1 === report.score1 &&
        score.p2 === report.score2) ||
        (p2 === first && p1 === second && score.p2 === report.score1 && score.p1 === report.score2))
    )
      add(row.id, report.picks!);
  }
  function addLateReport(
    id: string,
    report: Awaited<ReturnType<typeof lateCharacterReports>>[number],
  ) {
    const ids = members.get(id)?.map((member) => member.id) ?? [];
    if (sameCharacterParticipants(ids, report.participantIds.map(canonical))) add(id, report.picks);
  }
  for (const report of await lateCharacterReports(db, 'archive', archiveIds))
    addLateReport(report.matchId, report);
  if (!runtime && references.size) {
    const byMatch = new Map(
      [...references.values()].map(({ matchId }) => [matchId, [] as string[]]),
    );
    for (const [id, ref] of references) byMatch.get(ref.matchId)!.push(id);
    for (const report of await lateCharacterReports(db, 'native', [...byMatch.keys()]))
      for (const id of byMatch.get(report.matchId)!) addLateReport(id, report);
  }
  if (runtime) {
    const planIds = [...new Set([...references.values()].map(({ planId }) => planId))];
    for (const planId of planIds) {
      const state = await runtime.state(planId);
      const evidence = await nativeCharacterEvidence(db, state, undefined, canonical);
      for (const [id, ref] of references) {
        const picks = ref.planId === planId && evidence.get(ref.matchId);
        if (picks) add(id, picks);
      }
    }
  }
  return new Map<string, ArchivedCharacterSet>(
    played.map((row) => {
      const players = members.get(row.id) ?? [];
      return [
        row.id,
        {
          key: references.get(row.id)?.matchId ?? row.id,
          players,
          picks: agreedCharacters(reports.get(row.id) ?? []).filter((pick) =>
            players.some(({ id }) => id === pick.playerId),
          ),
        },
      ];
    }),
  );
}

export type ArchivedCharacterSet = {
  key: string;
  players: { id: string; name: string }[];
  picks: SetCharacterPick[];
};

export function archiveCharacterLeaders(evidence: Iterable<ArchivedCharacterSet>) {
  const bySet = new Map<string, SetCharacterPick[][]>();
  for (const { key, picks } of evidence) {
    const reports = bySet.get(key) ?? [];
    reports.push(picks);
    bySet.set(key, reports);
  }
  return leadingCharacters([...bySet.values()].map(agreedCharacters));
}
