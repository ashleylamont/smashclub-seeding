import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { eventNativeBrackets, eventMatches, eventPlans, eventPlanBrackets, eventScoreReports, eventMatchAudit, eventAttendanceAudit, eventWithdrawals, tournamentParticipants, tournaments, sets, players, type Db } from '@smashclub/db';
import { scoresIndicateUnplayed } from '@smashclub/shared';
import type { SessionUser } from '../auth';
import { getPlan } from '../event-planner/plans';
import { buildConsolationBracket, standardBracketOrder } from '../event-planner/advancement';
import { lockEvent, requireOperator } from './service';
function reject(message: string): never { throw new TRPCError({ code: 'CONFLICT', message }); }
const noContest = 'Both players withdrawn: no contest; no winner or score recorded';
const resolved = (match: typeof eventMatches.$inferSelect) => match.status === 'complete' || match.blockedReason === noContest;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function nativeDraw(entrantIds: readonly string[]) {
  if (new Set(entrantIds).size !== entrantIds.length) reject('A native bracket cannot contain the same entrant twice.');
  let size = 2;
  while (size < entrantIds.length) size *= 2;
  return entrantIds.length ? standardBracketOrder(size).map(seed => entrantIds[seed - 1] ?? null) : [];
}

export async function previewNativeBrackets(db: Db, planId: string) {
  const view = await getPlan(db, planId);
  if (!view) reject('Event not found.');
  const existing = await db.select().from(eventNativeBrackets).where(eq(eventNativeBrackets.eventPlanId, planId));
  const matches = await db.select().from(eventMatches).where(eq(eventMatches.eventPlanId, planId)).orderBy(asc(eventMatches.id));
  const reports = await db.select({ id: eventScoreReports.id }).from(eventScoreReports).where(and(eq(eventScoreReports.eventPlanId, planId), eq(eventScoreReports.status, 'pending')));
  const nativeIds = matches.filter(m => m.nativeBracketId).map(m => m.id);
  const nativeAudit = nativeIds.length ? await db.select().from(eventMatchAudit).where(inArray(eventMatchAudit.matchId, nativeIds)) : [];
  const issues: string[] = [];
  if (view.plan.bracketMode !== 'native') issues.push('This event uses Challonge brackets.');
  if (!['pools_ready', 'underway'].includes(view.plan.status)) issues.push('Prepare the pools in an open event first.');
  if (view.brackets.some(b => b.tournamentId || b.challongeSlug)) issues.push('Finalized or externally linked brackets cannot be rebuilt.');
  if (matches.some(m => m.nativeBracketId && (m.status === 'playing' || (m.status === 'complete' && m.outcome !== 'bye') || m.score1 !== null || m.score2 !== null || m.liveScore1 !== null || m.liveScore2 !== null))) issues.push('Finals have started. Existing play cannot be rebuilt.');
  if (nativeAudit.some(a => (a.after as { status?: string }).status === 'playing' || (a.before as { status?: string }).status === 'playing')) issues.push('A finals match has previously started; it cannot be reset.');
  if (reports.length) issues.push('Review pending score reports before generating finals.');
  const resetIssues = [...issues];
  if (!existing.length) resetIssues.push('There are no native finals to remove.');
  if (!matches.some(m => m.stage === 'group')) issues.push('Prepare and play the pool matches first.');
  if (matches.some(m => m.stage === 'group' && m.status !== 'complete' && m.blockedReason !== 'Both players withdrawn: no contest; no winner or score recorded')) issues.push('Resolve every pool match before generating finals.');
  const brackets = view.divisions.flatMap(division => {
    if (division.pools.some(pool => pool.members.some(member => member.place === null))) issues.push(`Confirm every ${division.division} pool order first.`);
    const championshipIds = new Set(division.championship.map(p => p.playerId));
    const finishers = division.pools.flatMap(pool => pool.members.filter(member => championshipIds.has(member.playerId)).sort((a,b)=>a.place!-b.place!).map((member,index) => ({ playerId: member.playerId, poolIndex: pool.poolIndex, place: index + 3 })));
    // The same seed-integrity repair used for consolation avoids immediate
    // pool rematches for championship qualifiers, including uneven fields.
    const main = finishers.length ? buildConsolationBracket(finishers).entrants : [];
    return [
      { division: division.division, stage: 'main' as const, entrantIds: main.map(p => p.playerId) },
      { division: division.division, stage: 'consolation' as const, entrantIds: division.consolation?.entrants.map(p => p.playerId) ?? [] },
    ].map(bracket => ({ ...bracket, roundOne: pairSlots(nativeDraw(bracket.entrantIds)) }));
  });
  return { allowed: issues.length === 0, issues, resetAllowed: resetIssues.length === 0, resetIssues, replacing: existing.length > 0, brackets,
    revisionToken: digest({ plan: view.plan.status, brackets, assignments: view.divisions.map(d => d.pools), matches: matches.map(m => [m.id, m.revision, m.status]), reports, existing: existing.map(b => b.id) }) };
}
function pairSlots(slots: Array<string | null>) { return Array.from({ length: slots.length / 2 }, (_, i) => ({ player1Id: slots[i * 2]!, player2Id: slots[i * 2 + 1]! })); }

export async function generateNativeBrackets(db: Db, user: SessionUser, planId: string, revisionToken: string) {
  return db.transaction(async tx => {
    await lockEvent(tx, planId); await requireOperator(tx, planId, user);
    const preview = await previewNativeBrackets(tx, planId);
    if (preview.revisionToken !== revisionToken) reject('The event changed since this finals preview. Preview again.');
    if (!preview.allowed) reject(preview.issues.join(' '));
    // Remove child dependencies before deleting an entirely unplayed draw.
    const old = await tx.select().from(eventNativeBrackets).where(eq(eventNativeBrackets.eventPlanId, planId));
    if (old.length) {
      await tx.update(eventMatches).set({ parent1MatchId: null, parent2MatchId: null }).where(inArray(eventMatches.nativeBracketId, old.map(b => b.id)));
      await tx.delete(eventNativeBrackets).where(eq(eventNativeBrackets.eventPlanId, planId));
    }
    for (const bracket of preview.brackets) {
      const [created] = await tx.insert(eventNativeBrackets).values({ eventPlanId: planId, division: bracket.division, stage: bracket.stage, entrantIds: bracket.entrantIds }).returning();
      let previous: string[] = [];
      const slots = nativeDraw(bracket.entrantIds);
      for (let width = slots.length / 2, round = 1; width >= 1; width /= 2, round++) {
        const current: string[] = [];
        for (let slot = 0; slot < width; slot++) {
          const id = randomUUID(); current.push(id);
          const p1 = round === 1 ? slots[slot * 2] ?? null : null;
          const p2 = round === 1 ? slots[slot * 2 + 1] ?? null : null;
          const bye = round === 1 && !!p1 !== !!p2;
          await tx.insert(eventMatches).values({ id, eventPlanId: planId, nativeBracketId: created!.id, nativeRound: round, nativeSlot: slot,
            sourceKey: `native:${bracket.division}:${bracket.stage}:${round}:${slot}`, division: bracket.division, stage: bracket.stage,
            label: `${bracket.division} ${bracket.stage === 'main' ? 'Championship' : 'Consolation'} · R${round} M${slot + 1}`,
            parent1MatchId: round === 1 ? null : previous[slot * 2]!, parent2MatchId: round === 1 ? null : previous[slot * 2 + 1]!,
            player1Id: p1, player2Id: p2, status: bye ? 'complete' : p1 && p2 ? 'ready' : 'blocked', outcome: bye ? 'bye' : null,
            winnerId: bye ? p1 ?? p2 : null, blockedReason: round > 1 ? 'Waiting for previous round winners' : null });
        }
        previous = current;
      }
    }
    await advanceNativeBrackets(tx, planId);
    await tx.insert(eventAttendanceAudit).values({ eventPlanId: planId, userId: user.id, action: 'native_finals_generated', details: { brackets: preview.brackets } });
    return { created: preview.brackets.length };
  });
}

/** Called within the same event lock as score entry and report approval. */
export async function assertNativeCorrectionAllowed(db: Db, match: typeof eventMatches.$inferSelect) {
  const [plan] = await db.select().from(eventPlans).where(eq(eventPlans.id, match.eventPlanId));
  if (plan?.bracketMode !== 'native') return;
  if (match.sourceSetId) reject('These native results have been finalized for ratings and cannot be edited.');
  const brackets = await db.select().from(eventNativeBrackets).where(and(eq(eventNativeBrackets.eventPlanId, match.eventPlanId), eq(eventNativeBrackets.division, match.division)));
  if (match.stage === 'group' && brackets.length) reject('Finals already use this pool order. Rebuild the unplayed finals before correcting pool results.');
  if (!match.nativeBracketId) return;
  if (match.outcome === 'bye') reject('Automatic bracket byes are fixed by the draw.');
  const all = await db.select().from(eventMatches).where(eq(eventMatches.nativeBracketId, match.nativeBracketId));
  const parents = [match.parent1MatchId, match.parent2MatchId].filter((id): id is string => !!id);
  if (parents.some(id => !all.some(parent => parent.id === id && resolved(parent)))) reject('Previous round matches must be resolved before recording this native result. An unresolved opponent is not a bye.');
  const audit = all.length ? await db.select().from(eventMatchAudit).where(inArray(eventMatchAudit.matchId, all.map(m => m.id))) : [];
  const started = new Set(audit.filter(a => (a.after as {status?:string}).status === 'playing' || (a.before as {status?:string}).status === 'playing').map(a => a.matchId));
  const downstream = new Set([match.id]);
  for (const item of all.sort((a, b) => (a.nativeRound ?? 0) - (b.nativeRound ?? 0))) {
    if (downstream.has(item.parent1MatchId ?? '') || downstream.has(item.parent2MatchId ?? '')) {
      if (item.status === 'playing' || item.status === 'complete' || item.score1 !== null || item.score2 !== null || item.liveScore1 !== null || item.liveScore2 !== null || started.has(item.id)) reject('A downstream match has started. Its feeder result cannot be changed.');
      downstream.add(item.id);
    }
  }
}
export async function advanceNativeBrackets(db: Db, planId: string) {
  const all = await db.select().from(eventMatches).where(eq(eventMatches.eventPlanId, planId)).orderBy(asc(eventMatches.nativeRound));
  const withdrawn = new Set((await db.select().from(eventWithdrawals).where(eq(eventWithdrawals.eventPlanId, planId))).map(w => w.playerId));
  const audit = all.length ? await db.select().from(eventMatchAudit).where(inArray(eventMatchAudit.matchId, all.map(m => m.id))) : [];
  const started = new Set(audit.filter(a => (a.after as {status?:string}).status === 'playing' || (a.before as {status?:string}).status === 'playing').map(a => a.matchId));
  const byId = new Map(all.map(m => [m.id, m]));
  for (const match of all) {
    if (!match.nativeBracketId || !match.parent1MatchId || !match.parent2MatchId) continue;
    const a = byId.get(match.parent1MatchId)!; const b = byId.get(match.parent2MatchId)!;
    const p1 = a.status === 'complete' ? a.winnerId : null; const p2 = b.status === 'complete' ? b.winnerId : null;
    const parentsResolved = resolved(a) && resolved(b);
    const vacancy = parentsResolved && (!p1 || !p2);
    if (p1 === match.player1Id && p2 === match.player2Id && (!vacancy || resolved(match))) continue;
    if (match.status === 'playing' || match.status === 'complete' || match.liveScore1 !== null || match.liveScore2 !== null || started.has(match.id)) reject('Cannot alter participants after downstream play starts.');
    const held = !!p1 && withdrawn.has(p1) || !!p2 && withdrawn.has(p2);
    const empty = vacancy && [p1, p2].every(id => !id || withdrawn.has(id));
    const bye = vacancy && !!(p1 ?? p2) && !held;
    const [updated] = await db.update(eventMatches).set({ player1Id: p1, player2Id: p2, status: bye ? 'complete' : p1 && p2 && !held ? 'ready' : 'blocked', outcome: bye ? 'bye' : null, winnerId: bye ? p1 ?? p2 : null, blockedReason: empty ? noContest : held ? 'Player withdrawn: awaiting organiser forfeit decision' : bye || p1 && p2 ? null : 'Waiting for previous round winners', revision: match.revision + 1 }).where(eq(eventMatches.id, match.id)).returning();
    byId.set(match.id, updated!);
  }
}
export async function nativeBracketViews(db: Db, planId: string) {
  const brackets = await db.select().from(eventNativeBrackets).where(eq(eventNativeBrackets.eventPlanId, planId));
  const matches = await db.select().from(eventMatches).where(eq(eventMatches.eventPlanId, planId));
  return brackets.map(bracket => {
    const rounds = matches.filter(m => m.nativeBracketId === bracket.id);
    const maxRound = Math.max(0, ...rounds.map(m => m.nativeRound ?? 0));
    const final = rounds.find(m => m.nativeRound === maxRound);
    const complete = bracket.entrantIds.length === 0 || !!final && resolved(final);
    const winnerId = complete ? final?.winnerId ?? null : null;
    const standings = !complete ? [] : rounds.flatMap(m => m.outcome !== 'bye' && m.status === 'complete' && m.winnerId && m.player1Id && m.player2Id
      ? [{ playerId: m.winnerId === m.player1Id ? m.player2Id : m.player1Id, place: 2 ** (maxRound - m.nativeRound!) + 1 }] : []);
    if (winnerId) standings.push({ playerId: winnerId, place: 1 });
    return { ...bracket, complete, winnerId, standings: standings.sort((a, b) => a.place - b.place) };
  });
}

export async function resetNativeBrackets(db: Db, user: SessionUser, planId: string, revisionToken: string) {
  return db.transaction(async tx => {
    await lockEvent(tx, planId); await requireOperator(tx, planId, user);
    const preview = await previewNativeBrackets(tx, planId);
    if (revisionToken !== preview.revisionToken) reject('The event changed; preview again before removing finals.');
    if (!preview.resetAllowed) reject(preview.resetIssues.join(' '));
    const brackets = await tx.select().from(eventNativeBrackets).where(eq(eventNativeBrackets.eventPlanId, planId));
    if (brackets.length) {
      await tx.update(eventMatches).set({ parent1MatchId: null, parent2MatchId: null }).where(inArray(eventMatches.nativeBracketId, brackets.map(b => b.id)));
      await tx.delete(eventNativeBrackets).where(eq(eventNativeBrackets.eventPlanId, planId));
    }
    await tx.insert(eventAttendanceAudit).values({ eventPlanId: planId, userId: user.id, action: 'native_finals_reset', details: { removed: brackets.length } });
    return { removed: brackets.length };
  });
}

/** Finalize exactly once into the existing ratings/history pipeline, without a remote service. */
export async function finalizeNativeEvent(db: Db, user: SessionUser, planId: string) {
  return db.transaction(async tx => {
    const [plan] = await tx.select().from(eventPlans).where(eq(eventPlans.id, planId)).for('update');
    if (!plan || plan.bracketMode !== 'native') reject('Only a native event can be finalized here.');
    await requireOperator(tx, planId, user);
    if (plan.status === 'complete') return { alreadyFinalized: true };
    if (!['pools_ready', 'underway'].includes(plan.status)) reject('The event is not open.');
    const brackets = await nativeBracketViews(tx, planId);
    if (brackets.length !== 4 || brackets.some(b => !b.complete)) reject('Complete championship and consolation in both divisions before finalizing.');
    const all = await tx.select().from(eventMatches).where(eq(eventMatches.eventPlanId, planId)).orderBy(asc(eventMatches.sourceKey));
    if (all.some(m => m.status !== 'complete' && m.blockedReason !== 'Both players withdrawn: no contest; no winner or score recorded')) reject('Resolve all remaining matches before finalizing.');
    const reports = await tx.select().from(eventScoreReports).where(and(eq(eventScoreReports.eventPlanId, planId), eq(eventScoreReports.status, 'pending')));
    if (reports.length) reject('Review pending player reports before finalizing.');
    for (const bracket of brackets) {
      const matches = all.filter(m => m.division === bracket.division && (m.nativeBracketId === bracket.id || bracket.stage === 'main' && m.stage === 'group'));
      if (!matches.length && !bracket.entrantIds.length) continue;
      const slug = `nemesis_${planId.replaceAll('-', '')}_${bracket.division}_${bracket.stage}`;
      const existing = await tx.select().from(tournaments).where(eq(tournaments.challongeSlug, slug));
      if (existing.length) reject('An internal results record already exists. Reconcile it before finalizing.');
      const [tournament] = await tx.insert(tournaments).values({ provider: 'native', challongeSlug: slug,
        name: `${plan.name} ${bracket.division === 'upper' ? 'Upper' : 'Lower'} ${bracket.stage === 'main' ? 'Main' : 'Consolation'}`,
        eventDate: plan.eventDate, eventDateManual: true, challongeState: 'complete', syncState: 'synced',
        raw: { provider: 'native', eventPlanId: planId, tournamentType: 'single elimination' },
      }).returning();
      const playerIds = [...new Set([...bracket.entrantIds, ...matches.flatMap(m => [m.player1Id, m.player2Id].filter((id): id is string => !!id))])];
      const names = playerIds.length ? await tx.select().from(players).where(inArray(players.id, playerIds)) : [];
      const participants = playerIds.length ? await tx.insert(tournamentParticipants).values(playerIds.map((playerId, index) => ({
        tournamentId: tournament!.id, challongeParticipantId: index + 1, playerId,
        rawName: names.find(p => p.id === playerId)!.canonicalName, cleanedName: names.find(p => p.id === playerId)!.canonicalName,
        finalRank: bracket.standings.find(p => p.playerId === playerId)?.place ?? null,
      }))).returning() : [];
      const participantId = (playerId: string | null) => participants.find(p => p.playerId === playerId)?.id ?? null;
      for (const [index, match] of matches.entries()) {
        const [stored] = await tx.insert(sets).values({ tournamentId: tournament!.id, challongeMatchId: index + 1,
          resultStage: match.stage === 'group' ? 'group' : 'final', state: 'complete', round: match.nativeRound ?? 0,
          identifier: match.label, suggestedPlayOrder: index + 1,
          p1ParticipantId: participantId(match.player1Id), p2ParticipantId: participantId(match.player2Id),
          p1PlayerId: match.player1Id, p2PlayerId: match.player2Id,
          winner: match.winnerId ? match.winnerId === match.player1Id ? 1 : 2 : null,
          scoresCsv: match.outcome === 'played' ? `${match.score1}-${match.score2}` : null,
          excludedFromRatings: match.outcome !== 'played' || scoresIndicateUnplayed(`${match.score1}-${match.score2}`), completedAt: match.resultUpdatedAt ?? new Date(),
          raw: { provider: 'native', eventMatchId: match.id, outcome: match.outcome },
        }).returning();
        await tx.update(eventMatches).set({ sourceSetId: stored!.id, syncState: 'synced' }).where(eq(eventMatches.id, match.id));
      }
      await tx.update(eventPlanBrackets).set({ tournamentId: tournament!.id, externalState: 'verified' }).where(and(eq(eventPlanBrackets.eventPlanId, planId), eq(eventPlanBrackets.division, bracket.division), eq(eventPlanBrackets.stage, bracket.stage)));
    }
    await tx.update(eventPlans).set({ status: 'complete', updatedAt: new Date() }).where(eq(eventPlans.id, planId));
    return { alreadyFinalized: false };
  });
}
