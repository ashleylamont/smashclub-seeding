import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { playerRatings, seedingRuns, tournaments, type Db } from '@smashclub/db';
import { importRegistryPlayers, registerTournamentSlugs } from '../src/bootstrap/importRegistry';
import { latestRecomputeId, runRecompute } from '../src/recompute/recompute';
import { createSeedingRun, latestSeedingRun, pushSeedingRun, reorderSeedingRun } from '../src/seeding/seeding';
import { syncTournament } from '../src/sync/sync';
import { createTestDb } from './helpers/testDb';
import { fixtureClient, type FixtureTournament } from './helpers/challongeFixtures';
import { reviewItems } from '@smashclub/db';

let db: Db;
let close: () => Promise<void>;

// A completed history tournament rates the players; an upcoming one is seeded.
const history: FixtureTournament = {
  slug: 'history1',
  state: 'complete',
  startedAt: '2025-01-10T18:00:00.000+11:00',
  participants: [
    { id: 1, name: '[ATL] Fox McCloud' },
    { id: 2, name: '[ATL] Samus Aran' },
    { id: 3, name: '[ATL] Kirby' },
  ],
  matches: [
    { id: 11, p1: 1, p2: 2, winner: 1, order: 1 },
    { id: 12, p1: 1, p2: 3, winner: 1, order: 2 },
    { id: 13, p1: 2, p2: 3, winner: 2, order: 3 },
  ],
};

const upcoming: FixtureTournament = {
  slug: 'upcoming1',
  state: 'pending',
  startedAt: '2025-02-01T18:00:00.000+11:00',
  participants: [
    { id: 21, name: '[ATL] Kirby', seed: 1 },
    { id: 22, name: '[ATL] Fox McCloud', seed: 2 },
    { id: 23, name: '[ATL] Samus Aran', seed: 3 },
  ],
  matches: [],
};

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await importRegistryPlayers(db, [
    { id: 'fox', canonical_name: 'Fox McCloud', company: 'ATL' },
    { id: 'samus', canonical_name: 'Samus Aran', company: 'ATL' },
    { id: 'kirby', canonical_name: 'Kirby', company: 'ATL' },
  ]);
  await registerTournamentSlugs(db, ['history1', 'upcoming1']);
});

afterEach(async () => {
  await close();
});

const entryName = (entry: { canonicalName: string | null; displayName: string | null; cleanedName: string }): string =>
  entry.canonicalName ? (entry.displayName ?? entry.canonicalName) : entry.cleanedName;

async function setupRatedAndUpcoming(): Promise<string> {
  const client = fixtureClient([history, upcoming]);
  const rows = await db.select().from(tournaments);
  for (const row of rows) {
    // `api` on purpose: seeding runs BEFORE an event starts, and the public
    // bracket derives its roster from matches that do not exist yet. This is
    // the one flow that genuinely needs the metered API.
    await syncTournament(db, client, row.id, { source: 'api' });
  }
  await runRecompute(db);
  return rows.find((row) => row.challongeSlug === 'upcoming1')!.id;
}

describe('seeding workbench', () => {
  it('auto-seeds by conservative rating from the latest recompute', async () => {
    const upcomingId = await setupRatedAndUpcoming();
    await createSeedingRun(db, upcomingId, null);
    const result = await latestSeedingRun(db, upcomingId);

    // Fox won everything, then Samus, then Kirby.
    expect(result!.entries.map(entryName)).toEqual(['Fox McCloud', 'Samus Aran', 'Kirby']);
    expect(result!.entries.map((entry) => entry.autoSeed)).toEqual([1, 2, 3]);
    expect(result!.entries[0]!.autoScore).not.toBeNull();
  });

  it('seeds on the conservative rating, not the club rating the board publishes', async () => {
    const upcomingId = await setupRatedAndUpcoming();
    await createSeedingRun(db, upcomingId, null);
    const result = await latestSeedingRun(db, upcomingId);

    // The two orders are allowed to disagree — a seed is a bet about a draw,
    // where an unknown player is expensive to be wrong about, while the board is
    // reporting who is best. What must hold is that the bracket used the
    // cautious number, so an unproven entrant is never handed a top seed.
    const recomputeId = await latestRecomputeId(db);
    const ratings = await db
      .select()
      .from(playerRatings)
      .where(eq(playerRatings.recomputeId, recomputeId!));
    const byPlayer = new Map(ratings.map((row) => [row.playerId, row]));

    for (const entry of result!.entries) {
      if (!entry.playerId) continue;
      expect(entry.autoScore).toBeCloseTo(byPlayer.get(entry.playerId)!.conservativeRating, 9);
    }
  });

  it('supports manual reorder and pushes seeds to Challonge with verification', async () => {
    const upcomingId = await setupRatedAndUpcoming();
    await createSeedingRun(db, upcomingId, null);
    const before = await latestSeedingRun(db, upcomingId);

    // Admin swaps seeds 2 and 3.
    const order = [
      before!.entries[0]!.participantId,
      before!.entries[2]!.participantId,
      before!.entries[1]!.participantId,
    ];
    await reorderSeedingRun(db, before!.run.id, order);
    const reordered = await latestSeedingRun(db, upcomingId);
    expect(reordered!.entries.map(entryName)).toEqual(['Fox McCloud', 'Kirby', 'Samus Aran']);

    // Push against a client whose PUTs mutate a local fixture copy, so the
    // verification re-fetch sees the new seeds.
    const pushFixture: FixtureTournament = {
      ...upcoming,
      participants: upcoming.participants.map((p) => ({ ...p })),
    };
    const pushedSeeds = new Map<number, number>();
    const client = fixtureClient([pushFixture]);
    client.updateParticipantSeed = async (_slug, participantId, seed) => {
      pushedSeeds.set(participantId, seed);
      const participant = pushFixture.participants.find((p) => p.id === participantId);
      if (participant) participant.seed = seed;
    };

    const result = await pushSeedingRun(db, client, reordered!.run.id);
    expect(result.pushed).toBe(3);
    expect(result.verified).toBe(true);
    // Fox (challonge id 22) -> 1, Kirby (21) -> 2, Samus (23) -> 3.
    expect(pushedSeeds.get(22)).toBe(1);
    expect(pushedSeeds.get(21)).toBe(2);
    expect(pushedSeeds.get(23)).toBe(3);

    const [run] = await db.select().from(seedingRuns).where(eq(seedingRuns.id, reordered!.run.id));
    expect(run!.status).toBe('pushed');
    expect(run!.pushedAt).not.toBeNull();
  });

  it('marks draft runs stale when the roster changes on re-sync', async () => {
    const upcomingId = await setupRatedAndUpcoming();
    await createSeedingRun(db, upcomingId, null);

    const grown: FixtureTournament = {
      ...upcoming,
      participants: [...upcoming.participants, { id: 24, name: '[ATL] Falco Lombardi', seed: 4 }],
    };
    await syncTournament(db, fixtureClient([grown]), upcomingId, { source: 'api' });

    const result = await latestSeedingRun(db, upcomingId);
    expect(result!.run.status).toBe('stale');
  });

  it('seeds unrated/unresolved participants last, alphabetically', async () => {
    const upcomingId = await setupRatedAndUpcoming();

    const withUnknowns: FixtureTournament = {
      ...upcoming,
      participants: [
        ...upcoming.participants,
        { id: 24, name: 'Zzz Newcomer', seed: 4 },
        { id: 25, name: 'Aaa Newcomer', seed: 5 },
      ],
    };
    await syncTournament(db, fixtureClient([withUnknowns]), upcomingId, { source: 'api' });
    // Unknowns are queued for review, still unresolved at seeding time.
    expect((await db.select().from(reviewItems)).length).toBeGreaterThan(0);

    await createSeedingRun(db, upcomingId, null);
    const result = await latestSeedingRun(db, upcomingId);
    expect(result!.entries.map(entryName)).toEqual([
      'Fox McCloud',
      'Samus Aran',
      'Kirby',
      'Aaa Newcomer',
      'Zzz Newcomer',
    ]);
  });

});
