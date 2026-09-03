import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { players, sets, tournamentParticipants, tournaments, type Db } from '@smashclub/db';
import { importRegistryPlayers } from '../src/bootstrap/importRegistry';
import { loadEventOverview } from '../src/events/overview';
import { createTestDb } from './helpers/testDb';

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await importRegistryPlayers(db, [
    { id: 'p1', canonical_name: 'Player One', company: 'X', aliases: [] },
    { id: 'p2', canonical_name: 'Player Two', company: 'X', aliases: [] },
    { id: 'p3', canonical_name: 'Player Three', company: 'X', aliases: [] },
    { id: 'p4', canonical_name: 'Player Four', company: 'X', aliases: [] },
  ]);
});
afterEach(async () => close());

async function playerIds(): Promise<string[]> {
  return (await db.select({ id: players.id }).from(players)).map((p) => p.id);
}
async function bracket(slug: string, name: string, complete = true): Promise<string> {
  const [t] = await db.insert(tournaments).values({ challongeSlug: slug, name, eventDate: new Date('2026-08-25T00:00:00Z'),
    challongeState: complete ? 'complete' : 'underway', raw: { tournamentType: 'single elimination' } }).returning({ id: tournaments.id });
  return t!.id;
}
async function entrants(tournamentId: string, ids: string[], ranks: Array<number | null> = []): Promise<string[]> {
  const rows = await db.insert(tournamentParticipants).values(ids.map((playerId, i) => ({ tournamentId, challongeParticipantId: i + 1, playerId, rawName: `P${i}`, cleanedName: `P${i}`, finalRank: ranks[i] ?? null }))).returning({ id: tournamentParticipants.id });
  return rows.map((r) => r.id);
}
async function match(tournamentId: string, p1: string, p2: string, winner: 1 | 2, round: number, score = '2-0') {
  await db.insert(sets).values({ tournamentId, challongeMatchId: Math.floor(Math.random() * 1e9), p1ParticipantId: p1, p2ParticipantId: p2,
    p1PlayerId: (await db.select({ playerId: tournamentParticipants.playerId }).from(tournamentParticipants).where(eq(tournamentParticipants.id, p1)))[0]!.playerId!,
    p2PlayerId: (await db.select({ playerId: tournamentParticipants.playerId }).from(tournamentParticipants).where(eq(tournamentParticipants.id, p2)))[0]!.playerId!,
    winner, round, state: 'complete', scoresCsv: score, excludedFromRatings: false, resultStage: 'final' });
}

describe('event overview standings', () => {
  it('combines main and consolation with final-field offset and sums records', async () => {
    const ids = await playerIds();
    const main = await bracket('night_upper', 'Night Upper Main');
    const cons = await bracket('night_upper_consolation', 'Night Upper Consolation');
    const mp = await entrants(main, ids.slice(0, 4), [1, 2, null, null]);
    const cp = await entrants(cons, ids.slice(2), [1, 2]);
    await match(main, mp[0]!, mp[1]!, 1, 1, '2-0');
    await match(cons, cp[0]!, cp[1]!, 1, 1, '2-0');
    await db.update(sets).set({ resultStage: 'group' }).where(eq(sets.tournamentId, main));
    await match(main, mp[0]!, mp[1]!, 1, 2, '2-0');
    const view = (await loadEventOverview(db, 'night_upper'))!;
    expect(view.divisions[0]!.players.map((p) => p.place)).toEqual([1, 2, 3, 4]);
    expect(view.divisions[0]!.players.reduce((n, p) => n + p.wins + p.losses, 0)).toBe(6);
  });

  it('withholds placements for incomplete brackets and derives tied semifinal losers', async () => {
    const ids = await playerIds();
    const t = await bracket('incomplete_upper', 'Incomplete Upper Main', false);
    const p = await entrants(t, ids.slice(0, 2));
    await match(t, p[0]!, p[1]!, 1, 1);
    expect((await loadEventOverview(db, 'incomplete_upper'))!.brackets[0]!.players.every((x) => x.place === null)).toBe(true);
    const s = await bracket('tied_upper', 'Tied Upper Main');
    const q = await entrants(s, ids, []);
    await match(s, q[0]!, q[1]!, 1, 2); await match(s, q[2]!, q[3]!, 1, 2);
    await match(s, q[0]!, q[2]!, 1, 3);
    const places = (await loadEventOverview(db, 'tied_upper'))!.brackets.find((b) => b.tournamentId === s)!.players.map((x) => x.place).sort();
    expect(places).toEqual([1, 2, 3, 3]);
  });

  it('does not infer unknown roles or count a 99-0 bye as a win', async () => {
    const ids = await playerIds();
    const t = await bracket('mystery', 'Mystery Night');
    const p = await entrants(t, ids.slice(0, 2));
    await match(t, p[0]!, p[1]!, 1, 1, '99-0');
    const b = (await loadEventOverview(db, 'mystery'))!.brackets[0]!;
    expect(b.division).toBeNull(); expect(b.stage).toBeNull();
    expect(b.players.every((x) => x.wins === 0 && x.losses === 0)).toBe(true);
  });
});

it('withholds inferred ranks for an unknown format', async () => {
  const t = await bracket('unknown', 'Unknown Upper Main');
  await db.update(tournaments).set({ raw: {} }).where(eq(tournaments.id, t));
  const p = await entrants(t, (await playerIds()).slice(0, 2));
  await match(t, p[0]!, p[1]!, 1, 1);
  const view = (await loadEventOverview(db, 'unknown'))!;
  expect(view.brackets[0]!.players.every(p => p.place === null)).toBe(true);
});

it('withholds combined places when two main brackets claim a division', async () => {
  const ids = (await playerIds()).slice(0, 2);
  for (const slug of ['main-a', 'main-b']) {
    const t = await bracket(slug, `${slug} Upper Main`);
    const p = await entrants(t, ids, [1, 2]);
    await match(t, p[0]!, p[1]!, 1, 1);
  }
  const view = (await loadEventOverview(db, 'main-a'))!;
  expect(view.divisions[0]!.notice).toContain('ambiguous');
  expect(view.divisions[0]!.players.every(p => p.place === null)).toBe(true);
  expect(view.brackets.every(b => b.players.some(p => p.place === 1))).toBe(true);
});

it('keeps undated tournaments separate and preserves unresolved entrants', async () => {
  const t = await bracket('undated', 'Undated');
  await bracket('other', 'Other');
  await db.update(tournaments).set({ eventDate: null }).where(eq(tournaments.id, t));
  await db.insert(tournamentParticipants).values({ tournamentId: t, challongeParticipantId: 1, rawName: 'Unknown', cleanedName: 'Unknown' });
  const view = (await loadEventOverview(db, 'undated'))!;
  expect(view.brackets).toHaveLength(1);
  expect(view.brackets[0]!.players[0]!.playerId).toBeNull();
  expect(view.warnings.join(' ')).toContain('Unlinked');
});

it('shares an event title and canonical slug across bracket entry points', async () => {
  await bracket('upper', 'Event (Upper Division)');
  await bracket('lower', 'Event (Lower Division)');
  const upper = (await loadEventOverview(db, 'upper'))!;
  const lower = (await loadEventOverview(db, 'lower'))!;
  expect(upper.canonicalSlug).toBe('upper');
  expect(lower.canonicalSlug).toBe(upper.canonicalSlug);
  expect(lower.name).toBe('Event');
});
