import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  eventPlanEntries,
  eventPlanBrackets,
  eventPlans,
  playerRatings,
  players,
  ratingEvents,
  sets,
  tournaments,
  type Db,
} from '@smashclub/db';
import { eventKeyOf } from '@smashclub/engine';
import { importRegistryPlayers } from '../src/bootstrap/importRegistry';
import { latestRecomputeId, runRecompute } from '../src/recompute/recompute';
import { syncTournament } from '../src/sync/sync';
import { buildExports } from '../src/event-planner/exports';
import { EventPlanValidationError } from '../src/event-planner/divisions';
import {
  EventPlanStateError,
  attachBracket,
  closePlan,
  detachBracket,
  createPlan,
  freezeRoster,
  generatePools,
  getPlan,
  previewRoster,
  removeEntry,
  reorderDivision,
  savePoolPlacements,
  unfreezeRoster,
  updateEntry,
  updatePlanDetails,
} from '../src/event-planner/plans';
import { createTestDb } from './helpers/testDb';
import { fixtureClient, type FixtureTournament } from './helpers/challongeFixtures';

let db: Db;
let close: () => Promise<void>;

/** 16 club members, "Player01" .. "Player16". */
const ROSTER = Array.from({ length: 16 }, (_, index) => {
  const n = String(index + 1).padStart(2, '0');
  return { id: `p${n}`, canonical_name: `Player${n} Surname${n}`, company: 'ATL' };
});

const EVENT_DATE = '2025-06-05T18:30:00.000+10:00';

/**
 * A completed round robin in which the lower-numbered player always wins, so
 * the leaderboard afterwards is Player01 first through Player16 last. Gives
 * the planner a real, deterministic ranking to freeze.
 */
function ladderHistory(): FixtureTournament {
  const participants = ROSTER.map((player, index) => ({ id: index + 1, name: player.canonical_name }));
  const matches = [];
  let matchId = 100;
  let order = 1;
  for (let i = 0; i < participants.length; i++) {
    for (let j = i + 1; j < participants.length; j++) {
      matches.push({
        id: matchId++,
        p1: participants[i]!.id,
        p2: participants[j]!.id,
        winner: participants[i]!.id,
        order: order++,
      });
    }
  }
  return {
    slug: 'history-ladder',
    state: 'complete',
    startedAt: '2025-05-01T18:00:00.000+10:00',
    completedAt: '2025-05-01T21:00:00.000+10:00',
    participants,
    matches,
  };
}

async function seedRatedClub(): Promise<void> {
  await importRegistryPlayers(db, ROSTER);
  const history = ladderHistory();
  const [tournament] = await db
    .insert(tournaments)
    .values({ challongeSlug: history.slug, name: history.slug })
    .returning({ id: tournaments.id });
  await syncTournament(db, fixtureClient([history]), tournament!.id, { source: 'api' });
  await runRecompute(db);
}

/** The pasted attendance list, complete with the decoration a real paste has. */
function pastedRoster(): string {
  return ROSTER.map((player, index) => {
    if (index === 0) return `1. ${player.canonical_name}`;
    if (index === 1) return `- [Atlas] ${player.canonical_name}`;
    if (index === 2) return `  ${player.canonical_name}  `;
    return player.canonical_name;
  }).join('\n');
}

async function createFullPlan(overrides: { upperTargetSize?: number | null } = {}): Promise<string> {
  const preview = await previewRoster(db, pastedRoster());
  return createPlan(
    db,
    {
      bracketMode: 'challonge',
      name: 'June Club Night',
      eventDate: new Date(EVENT_DATE),
      slugPrefix: 'june25',
      upperTargetSize: overrides.upperTargetSize === undefined ? 8 : overrides.upperTargetSize,
      rows: preview.map((row) => ({
        lineNumber: row.lineNumber,
        rawInput: row.rawInput,
        cleanedName: row.cleanedName,
        companyId: row.companyId,
        playerId: row.playerId,
        resolutionMethod: row.method,
        divisionPreference: 'auto' as const,
      })),
    },
    null,
  );
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  await close();
});

describe('roster preview', () => {
  it('resolves a messy paste against the registry without writing anything', async () => {
    await seedRatedClub();
    const before = await db.select().from(players);

    const preview = await previewRoster(db, pastedRoster());
    expect(preview).toHaveLength(16);
    expect(preview.every((row) => row.playerId !== null)).toBe(true);
    expect(preview[0]!.method).toBe('alias');
    // The row keeps what was pasted, decoration and all, next to what it means.
    expect(preview[0]!.rawInput).toBe('1. Player01 Surname01');
    expect(preview[0]!.cleanedName).toBe('Player01 Surname01');
    expect(preview[1]!.companyCode).toBe('ATL');

    // No players, aliases or review items were created by looking.
    expect(await db.select().from(players)).toHaveLength(before.length);
    expect(await db.select().from(eventPlans)).toHaveLength(0);
  });

  it('carries the current rank so the admin can sanity-check the split', async () => {
    await seedRatedClub();
    const preview = await previewRoster(db, pastedRoster());
    const byName = new Map(preview.map((row) => [row.cleanedName, row]));
    expect(byName.get('Player01 Surname01')!.currentRank).toBe(1);
    expect(byName.get('Player16 Surname16')!.currentRank).toBe(16);
    expect(byName.get('Player01 Surname01')!.seedingScore).not.toBeNull();
  });

  it('offers candidates but never auto-links a fuzzy match', async () => {
    await seedRatedClub();
    const [row] = await previewRoster(db, 'Playr04 Surnam04');
    expect(row!.playerId).toBeNull();
    expect(row!.method).toBe('unresolved');
    expect(row!.candidates.length).toBeGreaterThan(0);
  });
});

describe('freezing a plan', () => {
  it('splits Upper and Lower on the frozen leaderboard rank', async () => {
    await seedRatedClub();
    const planId = await createFullPlan();
    await freezeRoster(db, planId);

    const view = (await getPlan(db, planId))!;
    expect(view.plan.status).toBe('roster_frozen');
    expect(view.plan.rankingSnapshotAt).not.toBeNull();

    const upper = view.entries.filter((entry) => entry.assignedDivision === 'upper');
    const lower = view.entries.filter((entry) => entry.assignedDivision === 'lower');
    expect(upper).toHaveLength(8);
    expect(lower).toHaveLength(8);
    expect(upper.map((entry) => entry.snapshotRank).sort((a, b) => a! - b!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(
      upper.sort((a, b) => a.divisionSeed! - b.divisionSeed!).map((entry) => entry.divisionSeed),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('refuses to freeze while a row is unresolved, and says which', async () => {
    await seedRatedClub();
    const preview = await previewRoster(db, [pastedRoster(), 'Somebody Nobody Knows'].join('\n'));
    const planId = await createPlan(
      db,
      {
        name: 'Ragged Night',
        eventDate: new Date(EVENT_DATE),
        upperTargetSize: 8,
        rows: preview.map((row) => ({
          lineNumber: row.lineNumber,
          rawInput: row.rawInput,
          cleanedName: row.cleanedName,
          companyId: row.companyId,
          playerId: row.playerId,
          resolutionMethod: row.method,
          divisionPreference: 'auto' as const,
        })),
      },
      null,
    );

    const view = (await getPlan(db, planId))!;
    expect(view.issues.blocking.map((issue) => issue.code)).toContain('unresolved_rows');
    await expect(freezeRoster(db, planId)).rejects.toBeInstanceOf(EventPlanValidationError);
  });

  it('refuses to freeze a division with fewer than three players', async () => {
    await seedRatedClub();
    const planId = await createFullPlan({ upperTargetSize: 2 });
    await expect(freezeRoster(db, planId)).rejects.toThrow(/at least 3/);
  });

  it('is transactional: a rejected freeze leaves no half-written snapshot', async () => {
    await seedRatedClub();
    const planId = await createFullPlan({ upperTargetSize: 2 });
    await expect(freezeRoster(db, planId)).rejects.toThrow();

    const rows = await db.select().from(eventPlanEntries).where(eq(eventPlanEntries.eventPlanId, planId));
    expect(rows.every((row) => row.divisionSeed === null && row.assignedDivision === null)).toBe(true);
    expect(rows.every((row) => row.snapshotRank === null)).toBe(true);
    const [plan] = await db.select().from(eventPlans).where(eq(eventPlans.id, planId));
    expect(plan!.status).toBe('draft');
    expect(plan!.rankingSnapshotAt).toBeNull();
  });

  it('does not move anybody when the ratings are recomputed afterwards', async () => {
    await seedRatedClub();
    const planId = await createFullPlan();
    await freezeRoster(db, planId);
    const frozen = (await getPlan(db, planId))!.entries.map((entry) => ({
      id: entry.id,
      division: entry.assignedDivision,
      seed: entry.divisionSeed,
      rank: entry.snapshotRank,
    }));

    // A second club night turns the board upside down.
    const upset: FixtureTournament = {
      slug: 'history-upset',
      state: 'complete',
      startedAt: '2025-05-20T18:00:00.000+10:00',
      completedAt: '2025-05-20T21:00:00.000+10:00',
      participants: ROSTER.map((player, index) => ({ id: 500 + index, name: player.canonical_name })),
      matches: ROSTER.slice(0, 8).map((_, index) => ({
        id: 900 + index,
        // The bottom half beats the top half, repeatedly.
        p1: 500 + 15 - index,
        p2: 500 + index,
        winner: 500 + 15 - index,
        order: index + 1,
      })),
    };
    const [row] = await db
      .insert(tournaments)
      .values({ challongeSlug: upset.slug, name: upset.slug })
      .returning({ id: tournaments.id });
    await syncTournament(db, fixtureClient([upset]), row!.id, { source: 'api' });
    await runRecompute(db);

    const after = (await getPlan(db, planId))!;
    expect(
      after.entries.map((entry) => ({
        id: entry.id,
        division: entry.assignedDivision,
        seed: entry.divisionSeed,
        rank: entry.snapshotRank,
      })),
    ).toEqual(frozen);
    // The live board really did move — the plan is frozen, not merely unchanged.
    const moved = after.entries.filter((entry) => entry.currentRank !== entry.snapshotRank);
    expect(moved.length).toBeGreaterThan(0);
  });

  it('honours a pin against the ranking', async () => {
    await seedRatedClub();
    const planId = await createFullPlan();
    const draft = (await getPlan(db, planId))!;
    const top = draft.entries.find((entry) => entry.currentRank === 1)!;
    await updateEntry(db, planId, top.id, { divisionPreference: 'lower' });
    await freezeRoster(db, planId);

    const view = (await getPlan(db, planId))!;
    const pinned = view.entries.find((entry) => entry.id === top.id)!;
    expect(pinned.assignedDivision).toBe('lower');
    expect(pinned.divisionSeed).toBe(1);
    expect(view.entries.filter((entry) => entry.assignedDivision === 'upper')).toHaveLength(8);
  });

  it('will not let a frozen plan change who a row points at, or where they play', async () => {
    await seedRatedClub();
    const planId = await createFullPlan();
    await freezeRoster(db, planId);
    const view = (await getPlan(db, planId))!;
    await expect(updateEntry(db, planId, view.entries[0]!.id, { playerId: null })).rejects.toBeInstanceOf(
      EventPlanStateError,
    );
    // A pin would take effect only on a re-freeze, so accepting one here would
    // be a setting that visibly does nothing.
    await expect(
      updateEntry(db, planId, view.entries[0]!.id, { divisionPreference: 'lower' }),
    ).rejects.toBeInstanceOf(EventPlanStateError);
    await expect(removeEntry(db, planId, view.entries[0]!.id)).rejects.toBeInstanceOf(EventPlanStateError);
    await expect(updatePlanDetails(db, planId, { upperTargetSize: 12 })).rejects.toThrow(/Unfreeze/);
  });

  it('clears the snapshot on unfreeze and recomputes it on the next freeze', async () => {
    await seedRatedClub();
    const planId = await createFullPlan();
    await freezeRoster(db, planId);
    await unfreezeRoster(db, planId);

    const reopened = (await getPlan(db, planId))!;
    expect(reopened.plan.status).toBe('draft');
    expect(reopened.plan.rankingSnapshotAt).toBeNull();
    expect(reopened.entries.every((entry) => entry.assignedDivision === null)).toBe(true);

    await updatePlanDetails(db, planId, { upperTargetSize: 12 });
    await freezeRoster(db, planId);
    const refrozen = (await getPlan(db, planId))!;
    expect(refrozen.entries.filter((entry) => entry.assignedDivision === 'upper')).toHaveLength(12);
  });
});

describe('pools and manual reordering', () => {
  it('stripes each division into four-player pools', async () => {
    await seedRatedClub();
    const planId = await createFullPlan();
    await freezeRoster(db, planId);
    await generatePools(db, planId);

    const view = (await getPlan(db, planId))!;
    expect(view.plan.status).toBe('pools_ready');
    const upper = view.divisions.find((division) => division.division === 'upper')!;
    expect(upper.poolCount).toBe(2);
    expect(upper.pools.map((pool) => pool.members.map((member) => member.seed))).toEqual([
      [1, 4, 5, 8],
      [2, 3, 6, 7],
    ]);
    // Every entrant lands in exactly one pool.
    const seeded = view.divisions.flatMap((division) =>
      division.pools.flatMap((pool) => pool.members.map((member) => member.playerId)),
    );
    expect(new Set(seeded).size).toBe(16);
  });

  it('re-seeds a division from a manual order', async () => {
    await seedRatedClub();
    const planId = await createFullPlan();
    await freezeRoster(db, planId);
    const before = (await getPlan(db, planId))!.entries
      .filter((entry) => entry.assignedDivision === 'upper')
      .sort((a, b) => a.divisionSeed! - b.divisionSeed!);

    const reversed = [...before].reverse().map((entry) => entry.id);
    await reorderDivision(db, planId, 'upper', reversed);

    const after = (await getPlan(db, planId))!.entries
      .filter((entry) => entry.assignedDivision === 'upper')
      .sort((a, b) => a.divisionSeed! - b.divisionSeed!);
    expect(after.map((entry) => entry.id)).toEqual(reversed);
    expect(after.map((entry) => entry.divisionSeed)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('rejects a reorder that is not exactly the division', async () => {
    await seedRatedClub();
    const planId = await createFullPlan();
    await freezeRoster(db, planId);
    const view = (await getPlan(db, planId))!;
    const upper = view.entries.filter((entry) => entry.assignedDivision === 'upper');
    await expect(
      reorderDivision(db, planId, 'upper', upper.slice(1).map((entry) => entry.id)),
    ).rejects.toBeInstanceOf(EventPlanStateError);
  });
});

describe('pool results and the consolation bracket', () => {
  async function planWithPools(): Promise<string> {
    await seedRatedClub();
    const planId = await createFullPlan();
    await freezeRoster(db, planId);
    await generatePools(db, planId);
    return planId;
  }

  /** Record every pool of a division finishing in seed order. */
  async function recordResults(planId: string, division: 'upper' | 'lower'): Promise<void> {
    const view = (await getPlan(db, planId))!;
    const pools = view.divisions.find((entry) => entry.division === division)!.pools;
    await savePoolPlacements(
      db,
      planId,
      division,
      pools.map((pool) => ({
        poolIndex: pool.poolIndex,
        playerIdsInOrder: pool.members.map((member) => member.playerId),
      })),
    );
  }

  it('builds a consolation field of the thirds and fourths, with no pool rematch', async () => {
    const planId = await planWithPools();
    await recordResults(planId, 'upper');

    const view = (await getPlan(db, planId))!;
    const upper = view.divisions.find((division) => division.division === 'upper')!;
    expect(upper.consolation).not.toBeNull();
    expect(upper.consolation!.entrants.map((entrant) => entrant.label).sort()).toEqual(['A3', 'A4', 'B3', 'B4']);
    expect(upper.consolation!.rematches).toEqual([]);
    expect(upper.championship.map((qualifier) => qualifier.label)).toEqual(['A1', 'A2', 'B1', 'B2']);
  });

  it('rejects a pool result that is not exactly that pool', async () => {
    const planId = await planWithPools();
    const view = (await getPlan(db, planId))!;
    const upper = view.divisions.find((division) => division.division === 'upper')!;
    const wrong = [...upper.pools[0]!.members.map((member) => member.playerId)];
    wrong[0] = upper.pools[1]!.members[0]!.playerId;
    await expect(
      savePoolPlacements(db, planId, 'upper', [{ poolIndex: 0, playerIdsInOrder: wrong }]),
    ).rejects.toThrow(/exactly once/);
  });

  it('will not reseed a division once its pools have been played', async () => {
    const planId = await planWithPools();
    await recordResults(planId, 'upper');
    const upper = (await getPlan(db, planId))!.entries.filter((entry) => entry.assignedDivision === 'upper');
    await expect(
      reorderDivision(db, planId, 'upper', [...upper].reverse().map((entry) => entry.id)),
    ).rejects.toBeInstanceOf(EventPlanStateError);
  });

  it('will not reseed a division once its bracket exists in Challonge', async () => {
    const planId = await planWithPools();
    await attachBracket(db, planId, 'upper', 'main', 'june25_upper');
    const upper = (await getPlan(db, planId))!.entries.filter((entry) => entry.assignedDivision === 'upper');
    await expect(
      reorderDivision(db, planId, 'upper', [...upper].reverse().map((entry) => entry.id)),
    ).rejects.toThrow(/Detach it first/);
  });

  it('lets a mis-entered pool result be corrected', async () => {
    const planId = await planWithPools();
    await recordResults(planId, 'upper');
    const pools = (await getPlan(db, planId))!.divisions.find((entry) => entry.division === 'upper')!.pools;
    const swapped = [...pools[0]!.members.map((member) => member.playerId)];
    [swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];
    await savePoolPlacements(db, planId, 'upper', [{ poolIndex: 0, playerIdsInOrder: swapped }]);

    const after = (await getPlan(db, planId))!.divisions.find((entry) => entry.division === 'upper')!;
    expect(after.pools[0]!.members.find((member) => member.playerId === swapped[0])!.place).toBe(1);
  });
});

describe('exports', () => {
  it('exports public aliases in seed order, never the pasted line', async () => {
    await seedRatedClub();
    // One player has chosen a public alias; the export must use it.
    const [top] = await db.select().from(players).where(eq(players.canonicalName, 'Player01 Surname01'));
    await db.update(players).set({ displayName: 'Foxtrot' }).where(eq(players.id, top!.id));

    const planId = await createFullPlan();
    await freezeRoster(db, planId);
    await generatePools(db, planId);

    const exports = buildExports((await getPlan(db, planId))!);
    const upperMain = exports.brackets.find(
      (bracket) => bracket.division === 'upper' && bracket.stage === 'main',
    )!;
    const lines = upperMain.participants.split('\n');
    expect(lines).toHaveLength(8);
    expect(lines[0]).toBe('Foxtrot');
    // Not the raw paste, and not the registry name either.
    expect(upperMain.participants).not.toContain('1. Player01');
    expect(upperMain.participants).not.toContain('Player01 Surname01');
    // Everyone else falls back to the shortened alias.
    expect(lines[1]).toBe('Player02 S');
    expect(upperMain.audit.split('\n')[0]).toBe('1\tFoxtrot');
    expect(upperMain.suggestedSlug).toBe('june25_upper');
  });

  it('keeps the checklist honest about the rookie flag and the shared date', async () => {
    await seedRatedClub();
    const planId = await createFullPlan();
    await freezeRoster(db, planId);
    await generatePools(db, planId);
    const exports = buildExports((await getPlan(db, planId))!);
    for (const bracket of exports.brackets) {
      expect(bracket.checklist.join(' ')).toContain('2025-06-05');
      expect(bracket.checklist.join(' ')).toMatch(/not mark this bracket as rookie/i);
    }
  });

  it('prints pool cards for a venue with no connectivity', async () => {
    await seedRatedClub();
    const planId = await createFullPlan();
    await freezeRoster(db, planId);
    await generatePools(db, planId);
    const exports = buildExports((await getPlan(db, planId))!);
    expect(exports.poolCards).toHaveLength(4);
    expect(exports.poolCards[0]!.lines).toHaveLength(4);
  });
});

describe('attaching the four brackets', () => {
  async function readyPlan(): Promise<string> {
    await seedRatedClub();
    const planId = await createFullPlan();
    await freezeRoster(db, planId);
    await generatePools(db, planId);
    return planId;
  }

  it('registers each slug against the plan’s event date and never as rookie', async () => {
    const planId = await readyPlan();
    await attachBracket(db, planId, 'upper', 'main', 'june25_upper');
    await attachBracket(db, planId, 'upper', 'consolation', 'june25_upper_consolation');
    await attachBracket(db, planId, 'lower', 'main', 'https://challonge.com/june25_lower');
    await attachBracket(db, planId, 'lower', 'consolation', 'june25_lower_consolation');

    const rows = await db
      .select()
      .from(tournaments)
      .where(
        inArray(tournaments.challongeSlug, [
          'june25_upper',
          'june25_upper_consolation',
          'june25_lower',
          'june25_lower_consolation',
        ]),
      );
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.eventDate!.toISOString()).toBe(new Date(EVENT_DATE).toISOString());
      expect(row.eventDateManual).toBe(true);
      // Lower is a competitive division, not the rookie bracket.
      expect(row.isRookie).toBe(false);
    }
    // All four are one club night by the engine's own definition.
    expect(new Set(rows.map((row) => eventKeyOf(row.eventDate!.toISOString()))).size).toBe(1);
  });

  it('refuses to reopen a roster once a bracket exists remotely', async () => {
    const planId = await readyPlan();
    await attachBracket(db, planId, 'upper', 'main', 'june25_upper');
    await expect(unfreezeRoster(db, planId)).rejects.toThrow(/Detach it/);
  });

  it('refuses to attach the same slug to two of the plan’s brackets', async () => {
    const planId = await readyPlan();
    await attachBracket(db, planId, 'upper', 'main', 'june25_upper');
    await expect(attachBracket(db, planId, 'lower', 'main', 'june25_upper')).rejects.toThrow(/already attached/);
  });

  it('prevents bracket ownership leaking across event plans', async () => {
    const first = await readyPlan();
    const second = await createFullPlan();
    await freezeRoster(db, second);
    await attachBracket(db, first, 'upper', 'main', 'shared_bracket');
    await expect(attachBracket(db, second, 'upper', 'main', 'shared_bracket')).rejects.toThrow(/already attached/);
  });

  it('preserves ownership of historical tournament links without a stored slug', async () => {
    const first = await readyPlan();
    const second = await createFullPlan();
    await freezeRoster(db, second);
    const [historical] = await db.insert(tournaments).values({challongeSlug:'historical_owner',name:'Historical bracket',eventDate:new Date('2024-01-01T00:00:00Z')}).returning();
    const [slot] = await db.select().from(eventPlanBrackets).where(eq(eventPlanBrackets.eventPlanId,first));
    await db.update(eventPlanBrackets).set({tournamentId:historical!.id,challongeSlug:null}).where(eq(eventPlanBrackets.id,slot!.id));
    await expect(attachBracket(db, second, 'upper', 'main', 'historical_owner')).rejects.toThrow(/already attached/);
    expect((await db.select().from(tournaments).where(eq(tournaments.id,historical!.id)))[0]!.eventDate!.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect((await db.select().from(eventPlanBrackets).where(eq(eventPlanBrackets.id,slot!.id)))[0]!.challongeSlug).toBeNull();
  });

  it('requires reconciliation before changing placements after consolation handoff', async () => {
    const planId = await readyPlan();
    const view = (await getPlan(db, planId))!;
    const pool = view.divisions[0]!.pools[0]!;
    const placements = [{ poolIndex: pool.poolIndex, playerIdsInOrder: pool.members.map((member) => member.playerId) }];
    await savePoolPlacements(db, planId, 'upper', placements);
    await attachBracket(db, planId, 'upper', 'consolation', 'consolation_handoff');
    await expect(savePoolPlacements(db, planId, 'upper', placements)).rejects.toThrow(/Detach and reconcile/);
    await detachBracket(db, planId, 'upper', 'consolation');
    await savePoolPlacements(db, planId, 'upper', placements);
    await closePlan(db, planId, 'complete');
    await expect(detachBracket(db, planId, 'upper', 'main')).rejects.toThrow(/detach a bracket/);
  });

  it('freezes uneven divisions and advances the full remainder to consolation', async () => {
    await seedRatedClub();
    const planId = await createFullPlan({ upperTargetSize: 5 });
    await freezeRoster(db, planId);
    await generatePools(db, planId);
    const view = (await getPlan(db, planId))!;
    expect(view.divisions[0]!.pools.map((pool) => pool.members.length)).toEqual([5]);
    const pool = view.divisions[0]!.pools[0]!;
    await savePoolPlacements(db, planId, 'upper', [{ poolIndex: 0, playerIdsInOrder: pool.members.map((member) => member.playerId) }]);
    const upper = (await getPlan(db, planId))!.divisions[0]!;
    expect(upper.championship).toHaveLength(2);
    expect(upper.consolation!.entrants).toHaveLength(3);
  });

  it('refuses to move the event date out from under a registered bracket', async () => {
    const planId = await readyPlan();
    await attachBracket(db, planId, 'upper', 'main', 'june25_upper');
    await expect(
      updatePlanDetails(db, planId, { eventDate: new Date('2025-07-03T18:30:00.000+10:00') }),
    ).rejects.toThrow(/Detach them/);
    // Renaming is harmless and still allowed.
    await updatePlanDetails(db, planId, { name: 'June Club Night (rescheduled name only)' });
  });

  it('closes a plan out, one way', async () => {
    const planId = await readyPlan();
    await expect(closePlan(db, planId, 'complete')).resolves.toBeUndefined();
    expect((await getPlan(db, planId))!.plan.status).toBe('complete');
    // A closed plan is a record: it cannot be reopened into a runnable one.
    await expect(unfreezeRoster(db, planId)).rejects.toBeInstanceOf(EventPlanStateError);
    await expect(closePlan(db, planId, 'cancelled')).rejects.toBeInstanceOf(EventPlanStateError);
  });

  it('adopts an already-registered tournament rather than duplicating it', async () => {
    const planId = await readyPlan();
    await db.insert(tournaments).values({ challongeSlug: 'june25_upper', name: 'pre-registered' });
    const { tournamentId } = await attachBracket(db, planId, 'upper', 'main', 'june25_upper');
    const rows = await db.select().from(tournaments).where(eq(tournaments.challongeSlug, 'june25_upper'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(tournamentId);
    expect(rows[0]!.eventDate!.toISOString()).toBe(new Date(EVENT_DATE).toISOString());
  });
});

describe('the four brackets rate as one club night', () => {
  /** Two-stage bracket: group matches then a final stage, in one match list. */
  function mainBracket(slug: string, names: string[], idBase: number): FixtureTournament {
    const participants = names.map((name, index) => ({ id: idBase + index, name }));
    const matches = [];
    let matchId = idBase * 10;
    let order = 1;
    // Group stage: two pools of four, round robin.
    for (const pool of [participants.slice(0, 4), participants.slice(4)]) {
      for (let i = 0; i < pool.length; i++) {
        for (let j = i + 1; j < pool.length; j++) {
          matches.push({ id: matchId++, p1: pool[i]!.id, p2: pool[j]!.id, winner: pool[i]!.id, order: order++, stage: 'group' as const });
        }
      }
    }
    // Final stage: the four qualifiers.
    const qualifiers = [participants[0]!, participants[1]!, participants[4]!, participants[5]!];
    matches.push({ id: matchId++, p1: qualifiers[0]!.id, p2: qualifiers[3]!.id, winner: qualifiers[0]!.id, order: order++ });
    matches.push({ id: matchId++, p1: qualifiers[1]!.id, p2: qualifiers[2]!.id, winner: qualifiers[1]!.id, order: order++ });
    matches.push({ id: matchId++, p1: qualifiers[0]!.id, p2: qualifiers[1]!.id, winner: qualifiers[0]!.id, order: order++ });
    return {
      slug,
      state: 'complete',
      startedAt: EVENT_DATE,
      completedAt: '2025-06-05T22:00:00.000+10:00',
      participants,
      matches,
    };
  }

  function consolationBracket(slug: string, names: string[], idBase: number): FixtureTournament {
    const participants = names.map((name, index) => ({ id: idBase + index, name }));
    let matchId = idBase * 10;
    return {
      slug,
      state: 'complete',
      startedAt: EVENT_DATE,
      completedAt: '2025-06-05T22:00:00.000+10:00',
      participants,
      matches: [
        { id: matchId++, p1: participants[0]!.id, p2: participants[3]!.id, winner: participants[0]!.id, order: 1 },
        { id: matchId++, p1: participants[1]!.id, p2: participants[2]!.id, winner: participants[1]!.id, order: 2 },
        { id: matchId++, p1: participants[0]!.id, p2: participants[1]!.id, winner: participants[0]!.id, order: 3 },
      ],
    };
  }

  it('counts every set once and groups the four brackets into one event', async () => {
    await seedRatedClub();
    const planId = await createFullPlan();
    await freezeRoster(db, planId);
    await generatePools(db, planId);

    const view = (await getPlan(db, planId))!;
    // Match the frozen planner pool membership, not adjacent ranking seeds.
    const namesFor = (division: 'upper' | 'lower') => view.divisions.find(item => item.division === division)!.pools
      .flatMap(pool => pool.members.map(member => view.entries.find(entry => entry.playerId === member.playerId)!.playerName!));
    const upperNames = namesFor('upper');
    const lowerNames = namesFor('lower');

    const fixtures = [
      mainBracket('june25_upper', upperNames, 1000),
      consolationBracket('june25_upper_consolation', [upperNames[2]!, upperNames[3]!, upperNames[6]!, upperNames[7]!], 2000),
      mainBracket('june25_lower', lowerNames, 3000),
      consolationBracket('june25_lower_consolation', [lowerNames[2]!, lowerNames[3]!, lowerNames[6]!, lowerNames[7]!], 4000),
    ];
    const client = fixtureClient(fixtures);

    const slots = [
      ['upper', 'main', 'june25_upper'],
      ['upper', 'consolation', 'june25_upper_consolation'],
      ['lower', 'main', 'june25_lower'],
      ['lower', 'consolation', 'june25_lower_consolation'],
    ] as const;
    for (const [division, stage, slug] of slots) {
      const { tournamentId } = await attachBracket(db, planId, division, stage, slug);
      await syncTournament(db, client, tournamentId, { source: 'api' });
      // Idempotency: a second sync must not double anything.
      await syncTournament(db, client, tournamentId, { source: 'api' });
    }
    await runRecompute(db);

    const nightIds = (
      await db
        .select({ id: tournaments.id, eventDate: tournaments.eventDate })
        .from(tournaments)
        .where(
          inArray(tournaments.challongeSlug, [
            'june25_upper',
            'june25_upper_consolation',
            'june25_lower',
            'june25_lower_consolation',
          ]),
        )
    ).map((row) => row.id);

    // One set row per Challonge match, across both syncs of all four brackets.
    const nightSets = await db.select().from(sets).where(inArray(sets.tournamentId, nightIds));
    const expectedMatches = fixtures.reduce((total, fixture) => total + fixture.matches.length, 0);
    expect(nightSets).toHaveLength(expectedMatches);
    expect(nightSets.filter(set => set.resultStage === 'group')).toHaveLength(24);
    expect(nightSets.filter(set => set.resultStage === 'final')).toHaveLength(12);
    expect(new Set(nightSets.map((row) => `${row.tournamentId}:${row.challongeMatchId}`)).size).toBe(
      expectedMatches,
    );

    // Group-stage and elimination sets each rate once, not twice.
    const recomputeId = await latestRecomputeId(db);
    const events = await db
      .select()
      .from(ratingEvents)
      .where(eq(ratingEvents.recomputeId, recomputeId!));
    const nightEvents = events.filter((event) => nightIds.includes(event.tournamentId) && !event.isDecay);
    const rateable = nightSets.filter((row) => !row.excludedFromRatings && row.p1PlayerId && row.p2PlayerId);
    // Two rating events per rated set: one per player.
    expect(nightEvents).toHaveLength(rateable.length * 2);
    expect(new Set(nightEvents.map((event) => `${event.playerId}:${event.setId}`)).size).toBe(
      nightEvents.length,
    );

    // And the whole thing is one club night: two brackets each for eight people,
    // but every one of them attended one event.
    const ratings = await db
      .select()
      .from(playerRatings)
      .where(eq(playerRatings.recomputeId, recomputeId!));
    const played = ratings.filter((row) => row.tournamentCount > 1);
    expect(played.length).toBeGreaterThan(0);
    // Two brackets on the night, one event: the history bracket plus this night.
    for (const row of played) expect(row.eventCount).toBe(2);
  });
});
