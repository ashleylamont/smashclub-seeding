import { asc, eq, inArray, isNotNull } from 'drizzle-orm';
import { eventPlanBrackets, sets, tournamentParticipants, tournaments, players, companies, type Db } from '@smashclub/db';
import { eventKeyOf } from '@smashclub/engine';
import { compareEventBrackets, eventCanonicalSlug, eventNameOf, inferEventBracketRole, includesResultStage, publicParticipantName, scoresIndicateUnplayed } from '@smashclub/shared';

type PlaceSource = 'reported' | 'derived' | 'unavailable';
export interface EventOverviewPlayer {
  playerId: string | null;
  entryKey: string;
  name: string;
  place: number | null;
  placeSource: PlaceSource;
  inFinalStage: boolean;
  wins: number;
  losses: number;
  poolWins: number;
  poolLosses: number;
  bracketWins: number;
  bracketLosses: number;
  provisional: boolean;
  tournamentId: string;
}
export interface EventOverviewBracket {
  tournamentId: string;
  slug: string;
  name: string;
  division: 'upper' | 'lower' | null;
  stage: 'main' | 'consolation' | null;
  roleSource: 'plan' | 'name' | 'unclassified';
  finalFieldSize: number;
  isComplete: boolean;
  placeSource: PlaceSource;
  players: EventOverviewPlayer[];
}
export interface EventOverview {
  name: string;
  date: string | null;
  canonicalSlug: string;
  brackets: EventOverviewBracket[];
  divisions: Array<{ division: 'upper' | 'lower'; players: EventOverviewPlayer[]; notice: string | null }>;
  warnings: string[];
}
type StoredSet = typeof sets.$inferSelect;
const sortPlayers = (a: EventOverviewPlayer, b: EventOverviewPlayer) => (a.place ?? Infinity) - (b.place ?? Infinity) || a.name.localeCompare(b.name);
const validResult = (s: StoredSet) => s.state === 'complete' && (s.winner === 1 || s.winner === 2) && s.p1ParticipantId && s.p2ParticipantId && s.p1ParticipantId !== s.p2ParticipantId;

/** Explicit plan membership first; historical unlinked brackets fall back to event date. */
export async function loadEventOverview(db: Db, slug: string): Promise<EventOverview | null> {
  const [anchor] = await db.select().from(tournaments).where(eq(tournaments.challongeSlug, slug));
  if (!anchor) return null;
  const memberships = await db.select().from(eventPlanBrackets).where(isNotNull(eventPlanBrackets.tournamentId));
  const anchorPlanIds = new Set(memberships.filter(link => link.tournamentId === anchor.id).map(link => link.eventPlanId));
  const key = anchor.eventDate ? eventKeyOf(anchor.eventDate.toISOString()) : null;
  let eventRows: Array<typeof tournaments.$inferSelect>;
  if (anchorPlanIds.size === 1) {
    // A saved event is an explicit identity, even if another club night or an
    // unrelated bracket happens on the same calendar day.
    const planId = [...anchorPlanIds][0]!;
    const linkedIds = memberships.filter(link => link.eventPlanId === planId).flatMap(link => link.tournamentId ? [link.tournamentId] : []);
    eventRows = await db.select().from(tournaments).where(inArray(tournaments.id, linkedIds)).orderBy(asc(tournaments.eventDate));
  } else if (anchorPlanIds.size > 1 || key === null) {
    eventRows = [anchor];
  } else {
    const explicitlyLinked = new Set(memberships.map(link => link.tournamentId));
    const rows = await db.select().from(tournaments).where(isNotNull(tournaments.eventDate)).orderBy(asc(tournaments.eventDate));
    eventRows = rows.filter(row => !explicitlyLinked.has(row.id) && row.eventDate && eventKeyOf(row.eventDate.toISOString()) === key);
  }
  const ids = eventRows.map(row => row.id);
  const planRows = await db.select({ tournamentId: eventPlanBrackets.tournamentId, division: eventPlanBrackets.division, stage: eventPlanBrackets.stage })
    .from(eventPlanBrackets).where(inArray(eventPlanBrackets.tournamentId, ids));
  const participants = await db.select({ id: tournamentParticipants.id, tournamentId: tournamentParticipants.tournamentId, playerId: tournamentParticipants.playerId,
    cleanedName: tournamentParticipants.cleanedName, finalRank: tournamentParticipants.finalRank,
    canonicalName: players.canonicalName, displayName: players.displayName, companyCode: companies.code })
    .from(tournamentParticipants).leftJoin(players, eq(tournamentParticipants.playerId, players.id)).leftJoin(companies, eq(players.companyId, companies.id))
    .where(inArray(tournamentParticipants.tournamentId, ids));
  const setRows = await db.select().from(sets).where(inArray(sets.tournamentId, ids));
  const warnings: string[] = anchorPlanIds.size > 1 ? ['This bracket belongs to conflicting event plans; only its own results are shown.'] : [];
  if (eventRows.some(t => t.syncState !== 'synced')) warnings.push('Some brackets have not finished syncing; results may be incomplete.');
  if (participants.some(p => !p.playerId)) warnings.push('Unlinked entrants remain separate across brackets until their player identities are resolved.');
  const brackets: EventOverviewBracket[] = eventRows.map(t => {
    const roles = planRows.filter(p => p.tournamentId === t.id);
    const conflict = new Set(roles.map(p => `${p.division}:${p.stage}`)).size > 1;
    if (conflict) warnings.push(`${t.name} has conflicting plan links; its results are shown separately.`);
    const role = conflict ? null : roles[0] ?? inferEventBracketRole(t.name);
    const ps = participants.filter(p => p.tournamentId === t.id);
    const byId = new Map(ps.map(p => [p.id, p]));
    const bracketSets = setRows.filter(s => s.tournamentId === t.id);
    const finalSets = bracketSets.filter(s => s.resultStage === 'final');
    const finalIds = new Set(finalSets.flatMap(s => [s.p1ParticipantId, s.p2ParticipantId]).filter((id): id is string => id !== null));
    const finalPlayers = ps.filter(p => finalIds.has(p.id));
    const records = new Map<string, { wins: number; losses: number; poolWins: number; poolLosses: number; bracketWins: number; bracketLosses: number }>();
    for (const s of bracketSets) {
      if (!validResult(s) || s.excludedFromRatings || scoresIndicateUnplayed(s.scoresCsv) || !includesResultStage(t.resultsMode, s.resultStage)) continue;
      const p1 = byId.get(s.p1ParticipantId!); const p2 = byId.get(s.p2ParticipantId!);
      if (!p1 || !p2 || (p1.playerId && p1.playerId === p2.playerId)) continue;
      for (const [id, won] of [[p1.id, s.winner === 1], [p2.id, s.winner === 2]] as const) {
        const r = records.get(id) ?? { wins: 0, losses: 0, poolWins: 0, poolLosses: 0, bracketWins: 0, bracketLosses: 0 };
        won ? r.wins++ : r.losses++;
        if (s.resultStage === 'group') won ? r.poolWins++ : r.poolLosses++;
        else won ? r.bracketWins++ : r.bracketLosses++;
        records.set(id, r);
      }
    }
    const isComplete = t.challongeState === 'complete';
    const reported = isComplete && finalPlayers.length > 0 && finalPlayers.length === finalIds.size &&
      finalPlayers.every(p => p.finalRank !== null && Number.isInteger(p.finalRank) && p.finalRank >= 1 && p.finalRank <= finalIds.size) &&
      finalPlayers.filter(p => p.finalRank === 1).length === 1;
    const raw = t.raw as { tournamentType?: string; tournament_type?: string } | null;
    const type = raw?.tournamentType ?? raw?.tournament_type;
    const places = reported ? new Map(finalPlayers.map(p => [p.id, p.finalRank!])) :
      isComplete && type === 'single elimination' ? deriveSingleEliminationPlaces(finalSets, finalIds) : new Map<string, number>();
    const placeSource: PlaceSource = reported ? 'reported' : places.size ? 'derived' : 'unavailable';
    return { tournamentId: t.id, slug: t.challongeSlug, name: t.name, division: role?.division ?? null, stage: role?.stage ?? null,
      roleSource: role ? roles.length ? 'plan' : 'name' : 'unclassified', finalFieldSize: finalIds.size, isComplete, placeSource,
      players: ps.map(p => ({ playerId: p.playerId, entryKey: p.playerId ? `player:${p.playerId}` : `participant:${p.id}`, name: publicParticipantName(p),
        place: places.get(p.id) ?? null, placeSource: places.has(p.id) ? placeSource : 'unavailable' as const,
        inFinalStage: finalIds.has(p.id), wins: records.get(p.id)?.wins ?? 0, losses: records.get(p.id)?.losses ?? 0,
        poolWins: records.get(p.id)?.poolWins ?? 0, poolLosses: records.get(p.id)?.poolLosses ?? 0,
        bracketWins: records.get(p.id)?.bracketWins ?? 0, bracketLosses: records.get(p.id)?.bracketLosses ?? 0,
        provisional: !places.has(p.id), tournamentId: t.id })).sort(sortPlayers) };
  });
  brackets.sort(compareEventBrackets);
  const divisions = (['upper', 'lower'] as const).filter(division => brackets.some(b => b.division === division))
    .map(division => ({ division, ...combineDivision(brackets.filter(b => b.division === division)) }));
  return { name: eventNameOf(eventRows.map(row => row.name)), date: anchor.eventDate?.toISOString() ?? null,
    canonicalSlug: eventCanonicalSlug(brackets, slug), brackets, divisions, warnings };
}

/** Only a complete, structurally consistent single-elimination tree supports inferred ranks. */
function deriveSingleEliminationPlaces(matches: StoredSet[], field: Set<string>): Map<string, number> {
  const empty = new Map<string, number>();
  const contested = matches.filter(s => s.p1ParticipantId && s.p2ParticipantId);
  if (field.size < 2 || contested.length !== field.size - 1 || contested.some(s => !validResult(s) || !s.round || s.round < 1)) return empty;
  const maxRound = Math.max(...contested.map(s => s.round!));
  if (matches.some(s => (s.state !== 'complete' || s.winner === null) && (s.round ?? 0) >= maxRound)) return empty;
  const finals = contested.filter(s => s.round === maxRound);
  if (finals.length !== 1) return empty;
  const final = finals[0]!;
  const champion = (final.winner === 1 ? final.p1ParticipantId : final.p2ParticipantId)!;
  const losses = new Map<string, number>();
  for (const s of contested) {
    const loser = (s.winner === 1 ? s.p2ParticipantId : s.p1ParticipantId)!;
    if (losses.has(loser)) return empty;
    losses.set(loser, s.round!);
  }
  if (losses.has(champion) || losses.size !== field.size - 1) return empty;
  const out = new Map<string, number>([[champion, 1]]);
  for (const [id, round] of losses) {
    const place = 2 ** (maxRound - round) + 1;
    if (place > field.size) return empty;
    out.set(id, place);
  }
  return out;
}

function combineDivision(brackets: EventOverviewBracket[]): { players: EventOverviewPlayer[]; notice: string | null } {
  const mains = brackets.filter(b => b.stage === 'main');
  const consolations = brackets.filter(b => b.stage === 'consolation');
  const main = mains[0];
  const duplicateEntries = brackets.some(b => new Set(b.players.map(p => p.entryKey)).size !== b.players.length);
  const overlap = main && consolations.some(b => b.players.some(p => p.inFinalStage && main.players.some(m => m.inFinalStage && m.entryKey === p.entryKey)));
  const ambiguous = mains.length !== 1 || consolations.length > 1 || duplicateEntries || overlap;
  const canOffset = !ambiguous && main?.isComplete && main.placeSource !== 'unavailable' && main.finalFieldSize > 0;
  let notice: string | null = ambiguous ? 'Bracket membership is ambiguous; combined places are withheld. See the individual bracket results.' :
    !canOffset ? 'The championship results are incomplete or cannot be ranked; consolation places cannot yet be combined.' :
    !consolations.length ? 'No consolation bracket is linked for this division; players outside the championship remain unplaced.' : null;
  const out = new Map<string, EventOverviewPlayer>();
  for (const b of brackets) for (const p of b.players) {
    const place = ambiguous || !p.inFinalStage ? null : b.stage === 'main' ? p.place : canOffset && p.place !== null ? main!.finalFieldSize + p.place : null;
    const old = out.get(p.entryKey);
    const ranked = { ...p, place, provisional: place === null, placeSource: place === null ? 'unavailable' as const : p.placeSource };
    if (!old) out.set(p.entryKey, ranked);
    else out.set(p.entryKey, { ...(place !== null ? ranked : old), wins: old.wins + p.wins, losses: old.losses + p.losses,
      poolWins: old.poolWins + p.poolWins, poolLosses: old.poolLosses + p.poolLosses,
      bracketWins: old.bracketWins + p.bracketWins, bracketLosses: old.bracketLosses + p.bracketLosses });
  }
  if (!notice && [...out.values()].some(p => p.place === null)) notice = 'Some entrants have no final placement yet; their recorded sets still count towards W-L.';
  return { players: [...out.values()].sort(sortPlayers), notice };
}
