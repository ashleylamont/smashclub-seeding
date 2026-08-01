import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { identityDecisions, players, reviewItems, tournaments, type Db } from '@smashclub/db';
import { importRegistryPlayers, registerTournamentSlugs } from '../src/bootstrap/importRegistry';
import { recomputePendingCandidates } from '../src/identity/candidates';
import { resolveReviewItem } from '../src/review/resolve';
import { syncTournament } from '../src/sync/sync';
import { createTestDb } from './helpers/testDb';
import { adminCaller } from './helpers/adminCaller';
import { fixtureClient, type FixtureTournament } from './helpers/challongeFixtures';

/**
 * The "Anthy" bug: `review_items.candidates` is a snapshot taken when sync
 * queues the item, so a player created afterwards was invisible to it forever
 * and the queue kept insisting there were no candidates.
 */

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await importRegistryPlayers(db, [{ id: 'jackson', canonical_name: 'Jackson Lin', company: 'ATL' }]);
  await registerTournamentSlugs(db, ['devprod-punchout']);
});

afterEach(async () => {
  await close();
});

/** Sync a bracket whose entrants nobody in the registry answers to. */
async function syncWithParticipants(names: string[]): Promise<string> {
  const fixture: FixtureTournament = {
    slug: 'devprod-punchout',
    state: 'complete',
    participants: names.map((name, index) => ({ id: index + 1, name })),
    matches: [{ id: 11, p1: 1, p2: 2, winner: 1, order: 1 }],
  };
  const [row] = await db
    .select({ id: tournaments.id })
    .from(tournaments)
    .where(eq(tournaments.challongeSlug, 'devprod-punchout'));
  await syncTournament(db, fixtureClient([fixture]), row!.id);
  return row!.id;
}

async function anthyItem() {
  const [item] = await db.select().from(reviewItems).where(eq(reviewItems.cleanedName, 'Anthy'));
  return item!;
}

describe('review-queue candidates stay current', () => {
  it('offers a player created after the item was queued (the Anthy case)', async () => {
    await syncWithParticipants(['Anthy', '[ATL] Jackson Lin']);

    const queued = await anthyItem();
    expect(queued.candidates).toEqual([]);

    const caller = adminCaller(db);
    const { playerId } = await caller.createPlayer({
      canonicalName: 'Anthy',
      displayName: null,
      companyCode: null,
      characters: [],
      aliases: [],
    });

    const [item] = (await caller.reviewQueue()).filter((row) => row.cleanedName === 'Anthy');
    expect(item!.candidates).toHaveLength(1);
    expect((item!.candidates as Array<{ playerId: string }>)[0]!.playerId).toBe(playerId);
    expect(new Date(item!.candidatesComputedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(item!.createdAt).getTime(),
    );
  });

  it('stamps candidatesComputedAt even when the answer is still "nothing"', async () => {
    await syncWithParticipants(['Anthy', '[ATL] Jackson Lin']);
    const before = await anthyItem();

    const result = await adminCaller(db).recomputeReviewCandidates();
    expect(result).toEqual({ scanned: 1, changed: 0 });

    const after = await anthyItem();
    expect(after.candidates).toEqual([]);
    expect(after.candidatesComputedAt.getTime()).toBeGreaterThanOrEqual(before.candidatesComputedAt.getTime());
  });

  it('picks up a rename of an existing player', async () => {
    await syncWithParticipants(['Anthy', '[ATL] Jackson Lin']);
    const [jackson] = await db.select().from(players).where(eq(players.legacyId, 'jackson'));

    await adminCaller(db).updatePlayer({ playerId: jackson!.id, canonicalName: 'Anthy Lin' });

    const item = await anthyItem();
    const candidates = item.candidates as Array<{ playerId: string; name: string }>;
    expect(candidates.map((candidate) => candidate.playerId)).toContain(jackson!.id);
  });

  it('never resurrects a kept-separate pairing', async () => {
    await syncWithParticipants(['Anthy', '[ATL] Jackson Lin']);
    const [jackson] = await db.select().from(players).where(eq(players.legacyId, 'jackson'));
    await db.insert(identityDecisions).values({
      kind: 'keep_separate',
      aliasNorm: 'anthy',
      companyId: null,
      keptSeparateFromPlayerId: jackson!.id,
    });
    // A player the reviewer has explicitly rejected, under the exact name.
    await db.update(players).set({ canonicalName: 'Anthy' }).where(eq(players.id, jackson!.id));

    await recomputePendingCandidates(db);

    const item = await anthyItem();
    expect(item.candidates).toEqual([]);
  });

  it('leaves resolved items alone', async () => {
    await syncWithParticipants(['Anthy', '[ATL] Jackson Lin']);
    const queued = await anthyItem();
    await resolveReviewItem(db, queued.id, { kind: 'created_new' }, null);

    const before = await db.select().from(reviewItems).where(eq(reviewItems.id, queued.id));
    const result = await recomputePendingCandidates(db);
    expect(result.scanned).toBe(0);

    const after = await db.select().from(reviewItems).where(eq(reviewItems.id, queued.id));
    expect(after[0]!.status).toBe('resolved');
    expect(after[0]!.resolvedPlayerId).toBe(before[0]!.resolvedPlayerId);
    expect(after[0]!.candidatesComputedAt.getTime()).toBe(before[0]!.candidatesComputedAt.getTime());
  });

  it('drops a merged player and offers the survivor instead', async () => {
    await syncWithParticipants(['Anthy', '[ATL] Jackson Lin']);
    const caller = adminCaller(db);
    const { playerId: anthyId } = await caller.createPlayer({
      canonicalName: 'Anthy',
      displayName: null,
      companyCode: null,
      characters: [],
      aliases: [],
    });
    const { playerId: survivorId } = await caller.createPlayer({
      canonicalName: 'Anthy Rose',
      displayName: null,
      companyCode: null,
      characters: [],
      aliases: [],
    });

    await caller.mergePlayers({ fromPlayerId: anthyId, intoPlayerId: survivorId });

    const item = await anthyItem();
    const candidates = item.candidates as Array<{ playerId: string }>;
    expect(candidates.map((candidate) => candidate.playerId)).not.toContain(anthyId);
    expect(candidates.map((candidate) => candidate.playerId)).toContain(survivorId);
  });

  it('offers a player whose alias — not their registry name — resembles the entry', async () => {
    await syncWithParticipants(['Anthy', '[ATL] Jackson Lin']);
    const [jackson] = await db.select().from(players).where(eq(players.legacyId, 'jackson'));
    // Nothing about "Jackson Lin" resembles "Anthy"; the alias is the only link.
    expect((await anthyItem()).candidates).toEqual([]);

    await adminCaller(db).addAlias({ playerId: jackson!.id, alias: 'Anthea', companyCode: null });

    const candidates = (await anthyItem()).candidates as Array<{
      playerId: string;
      name: string;
      matchedAlias: string | null;
    }>;
    expect(candidates.map((candidate) => candidate.playerId)).toContain(jackson!.id);
    const hit = candidates.find((candidate) => candidate.playerId === jackson!.id)!;
    expect(hit.name).toBe('Jackson Lin');
    expect(hit.matchedAlias).toBe('anthea');
  });

  it('leaves matchedAlias null when the registry name is what matched', async () => {
    await syncWithParticipants(['Anthy', '[ATL] Jackson Lin']);
    const [jackson] = await db.select().from(players).where(eq(players.legacyId, 'jackson'));
    await adminCaller(db).updatePlayer({ playerId: jackson!.id, canonicalName: 'Anthy Lin' });

    const candidates = (await anthyItem()).candidates as Array<{ playerId: string; matchedAlias: string | null }>;
    expect(candidates.find((candidate) => candidate.playerId === jackson!.id)?.matchedAlias).toBeNull();
  });

  it('refreshes open items when a registry import adds the missing player', async () => {
    await syncWithParticipants(['Anthy', '[ATL] Jackson Lin']);
    const caller = adminCaller(db);

    const result = await caller.applyRegistryImport({
      yaml: 'players:\n  - id: anthy\n    canonical_name: Anthy\n',
    });
    expect(result.created).toBe(1);
    expect(result.candidates.changed).toBe(1);

    const [anthy] = await db.select().from(players).where(eq(players.legacyId, 'anthy'));
    const item = await anthyItem();
    expect((item.candidates as Array<{ playerId: string }>).map((c) => c.playerId)).toContain(anthy!.id);
  });
});
