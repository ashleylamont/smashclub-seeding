import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, or } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { eventMatches, eventPlanBrackets, eventPlanEntries, eventPlanPoolPlacements, eventPoolAssignments, eventPlans, eventScoreReports, players, sets, tournamentParticipants, tournaments, type Db, type HistoricalAdoptionDifferences, type HistoricalAdoptionRecord } from '@smashclub/db';

export interface HistoricalBracketInput { division: 'upper' | 'lower'; stage: 'main' | 'consolation'; tournamentId: string }
export interface HistoricalAdoptionInput { planId: string; brackets: HistoricalBracketInput[] }
const fail = (message: string): never => { throw new TRPCError({ code: 'CONFLICT', message }); };
const sortSlots = (brackets: HistoricalBracketInput[]) => [...brackets].sort((a, b) => `${a.division}:${a.stage}`.localeCompare(`${b.division}:${b.stage}`));

export async function historicalCandidates(db: Db, planId: string) {
  if (!(await db.select({ id: eventPlans.id }).from(eventPlans).where(eq(eventPlans.id, planId)))[0])
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Event plan not found.' });
  const rows = await db.select().from(tournaments).where(and(eq(tournaments.challongeState, 'complete'), eq(tournaments.syncState, 'synced'))).orderBy(asc(tournaments.name));
  const participants = rows.length ? await db.select({ tournamentId: tournamentParticipants.tournamentId }).from(tournamentParticipants).where(inArray(tournamentParticipants.tournamentId, rows.map(t => t.id))) : [];
  return rows.map(t => ({ tournamentId: t.id, name: t.name, slug: t.challongeSlug, eventDate: t.eventDate?.toISOString() ?? null, participantCount: participants.filter(p => p.tournamentId === t.id).length }));
}

/** Read-only comparison. Imported identities are compared by ID, never fuzzy-matched. */
export async function previewHistoricalAdoption(db: Db, input: HistoricalAdoptionInput) {
  const [plan] = await db.select().from(eventPlans).where(eq(eventPlans.id, input.planId));
  if (!plan) throw new TRPCError({ code: 'NOT_FOUND', message: 'Event plan not found.' });
  const choices = sortSlots(input.brackets);
  if (choices.length !== 4 || new Set(choices.map(b => `${b.division}:${b.stage}`)).size !== 4 || new Set(choices.map(b => b.tournamentId)).size !== 4)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Select four different tournaments, one for every division and stage.' });
  const ids = choices.map(b => b.tournamentId);
  const imported = await db.select().from(tournaments).where(inArray(tournaments.id, ids)).orderBy(asc(tournaments.id));
  if (imported.length !== 4) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Select existing imported tournaments.' });
  const links = await db.select().from(eventPlanBrackets).where(or(eq(eventPlanBrackets.eventPlanId, input.planId), inArray(eventPlanBrackets.tournamentId, ids), inArray(eventPlanBrackets.challongeSlug, imported.map(t => t.challongeSlug)))).orderBy(asc(eventPlanBrackets.id));
  const entries = await db.select().from(eventPlanEntries).where(eq(eventPlanEntries.eventPlanId, input.planId)).orderBy(asc(eventPlanEntries.id));
  const originalPools = await db.select().from(eventPoolAssignments).where(eq(eventPoolAssignments.eventPlanId, input.planId)).orderBy(asc(eventPoolAssignments.id));
  const originalPlacements = await db.select().from(eventPlanPoolPlacements).where(eq(eventPlanPoolPlacements.eventPlanId, input.planId)).orderBy(asc(eventPlanPoolPlacements.id));
  const participants = await db.select().from(tournamentParticipants).where(inArray(tournamentParticipants.tournamentId, ids)).orderBy(asc(tournamentParticipants.id));
  const importedSets = await db.select().from(sets).where(inArray(sets.tournamentId, ids)).orderBy(asc(sets.id));
  const matches = await db.select({ id: eventMatches.id }).from(eventMatches).where(eq(eventMatches.eventPlanId, input.planId));
  const reports = await db.select({ id: eventScoreReports.id }).from(eventScoreReports).where(eq(eventScoreReports.eventPlanId, input.planId));
  const playerIds = [...new Set([...entries, ...participants].flatMap(p => p.playerId ? [p.playerId] : []))];
  const names = new Map((playerIds.length ? await db.select({ id: players.id, name: players.canonicalName }).from(players).where(inArray(players.id, playerIds)).orderBy(asc(players.id)) : []).map(p => [p.id, p.name]));
  const blocking: string[] = [];
  const warnings: string[] = [];
  if (plan.status === 'cancelled') blocking.push('Cancelled plans cannot adopt historical results.');
  if (matches.length || reports.length) blocking.push('This plan has operational matches or reports. Reconcile its operational history before adopting imported results.');
  for (const t of imported) {
    if (t.challongeState !== 'complete' || t.syncState !== 'synced') blocking.push(`${t.name} must be completed and successfully synced first.`);
    if (links.some(l => l.eventPlanId !== input.planId && (l.tournamentId === t.id || l.challongeSlug === t.challongeSlug))) blocking.push(`${t.name} is already linked to another event plan.`);
    if (!participants.some(p => p.tournamentId === t.id)) blocking.push(`${t.name} has no imported participants.`);
    if (!importedSets.some(s => s.tournamentId === t.id)) blocking.push(`${t.name} has no imported matches.`);
  }
  if (participants.some(p => !p.playerId)) warnings.push('Some imported entrants have unresolved identities. They remain separate until linked to players; no identity or placing will be guessed.');
  if (imported.some(t => t.eventDate?.toISOString().slice(0, 10) !== plan.eventDate.toISOString().slice(0, 10))) warnings.push('Some bracket dates differ from the planned event date. Their original dates will be preserved.');
  const planned = new Map(entries.flatMap(e => e.playerId ? [[e.playerId, e] as const] : []));
  const actual = new Map(participants.flatMap(p => p.playerId ? [[p.playerId, p] as const] : []));
  const differences: HistoricalAdoptionDifferences = {
    plannedOnly: entries.filter(e => !e.playerId || !actual.has(e.playerId)).map(e => ({ playerId: e.playerId, name: e.playerId ? names.get(e.playerId) ?? e.cleanedName : e.cleanedName })),
    actualOnly: participants.filter(p => !p.playerId || (!planned.has(p.playerId) && actual.get(p.playerId)?.id === p.id)).map(p => ({ playerId: p.playerId, name: p.playerId ? names.get(p.playerId) ?? p.cleanedName : p.cleanedName })),
    divisionChanges: [],
  };
  for (const [id, participant] of actual) {
    const entry = planned.get(id);
    const divisions = new Set(participants.filter(p => p.playerId === id).map(p => choices.find(c => c.tournamentId === p.tournamentId)!.division));
    if (divisions.size > 1) warnings.push(`${names.get(id) ?? participant.cleanedName} appears in both imported divisions; combined results may remain ambiguous.`);
    if (divisions.size === 1 && entry?.assignedDivision && !divisions.has(entry.assignedDivision)) differences.divisionChanges.push({ playerId: id, name: names.get(id) ?? entry.cleanedName, plannedDivision: entry.assignedDivision, actualDivision: [...divisions][0]! });
  }
  warnings.push('Original roster, seeds and pools will be preserved as planning intent. Imported results describe what actually happened; no planned matches will be generated.');
  const brackets = choices.map(choice => { const t = imported.find(t => t.id === choice.tournamentId)!; return { ...choice, name: t.name, slug: t.challongeSlug, participantCount: participants.filter(p => p.tournamentId === t.id).length, previousSlug: links.find(l => l.eventPlanId === input.planId && l.division === choice.division && l.stage === choice.stage)?.challongeSlug ?? null }; });
  // Include complete source facts and prior adoption metadata so repeat corrections
  // and concurrent imports cannot silently apply an obsolete comparison.
  const fingerprint = createHash('sha256').update(JSON.stringify({ plan, choices, links, entries, originalPools, originalPlacements, participants, importedSets, imported, matches, reports, names: [...names] })).digest('hex');
  return { fingerprint, brackets, differences, warnings, blocking };
}

export async function applyHistoricalAdoption(db: Db, input: HistoricalAdoptionInput & { fingerprint: string }, actorId: string) {
  return db.transaction(async tx => {
    const [plan] = await tx.select().from(eventPlans).where(eq(eventPlans.id, input.planId)).for('update');
    if (!plan) throw new TRPCError({ code: 'NOT_FOUND', message: 'Event plan not found.' });
    // Same durable tournament locks as ordinary attachment; sorted to prevent
    // deadlocks when two historical repairs select overlapping brackets.
    for (const id of [...new Set(input.brackets.map(b => b.tournamentId))].sort())
      await tx.select({ id: tournaments.id }).from(tournaments).where(eq(tournaments.id, id)).for('update');
    // Administrative identity and score corrections may update child rows
    // directly, without the tournament lock used by imports.
    const selectedIds = input.brackets.map(b => b.tournamentId);
    if (selectedIds.length) {
      await tx.select({ id: tournamentParticipants.id }).from(tournamentParticipants).where(inArray(tournamentParticipants.tournamentId, selectedIds)).orderBy(asc(tournamentParticipants.id)).for('update');
      await tx.select({ id: sets.id }).from(sets).where(inArray(sets.tournamentId, selectedIds)).orderBy(asc(sets.id)).for('update');
    }
    const preview = await previewHistoricalAdoption(tx, input);
    if (preview.fingerprint !== input.fingerprint) fail('The plan or imported results changed. Preview the adoption again.');
    if (preview.blocking.length) fail(preview.blocking.join(' '));
    const previousBrackets = (await tx.select().from(eventPlanBrackets).where(eq(eventPlanBrackets.eventPlanId, input.planId))).map(({ division, stage, tournamentId, challongeSlug }) => ({ division, stage, tournamentId, challongeSlug }));
    const record: HistoricalAdoptionRecord = { adoptedAt: new Date().toISOString(), adoptedBy: actorId, previousStatus: plan.status, previousBrackets, brackets: preview.brackets, differences: preview.differences, warnings: preview.warnings };
    for (const bracket of preview.brackets) {
      await tx.insert(eventPlanBrackets).values({ eventPlanId: input.planId, division: bracket.division, stage: bracket.stage, tournamentId: bracket.tournamentId, challongeSlug: bracket.slug, externalState: 'attached' }).onConflictDoUpdate({ target: [eventPlanBrackets.eventPlanId, eventPlanBrackets.division, eventPlanBrackets.stage], set: { tournamentId: bracket.tournamentId, challongeSlug: bracket.slug, externalState: 'attached', lastError: null, updatedAt: new Date() } });
    }
    const previous = plan.historicalAdoption;
    const history = previous ? [...previous.history, (({ history: _history, ...rest }) => rest)(previous)] : [];
    await tx.update(eventPlans).set({ status: 'complete', historicalAdoption: { ...record, history }, updatedAt: new Date() }).where(eq(eventPlans.id, input.planId));
    return { planId: input.planId };
  });
}
