import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryStore } from '@rotorsoft/act';
import { eq } from 'drizzle-orm';
import { players, tournaments, user, type Db } from '@smashclub/db';
import { ChallongeClient } from '../src/challonge/client';
import { loadEnv } from '../src/env';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { publishNativeResult } from '../src/tournament/publication';
import { createNativeRuntime, type NativeRuntime } from '../src/tournament/runtime';
import { appRouter } from '../src/trpc/router';
import { nativeAdmin } from './helpers/nativeLiveFixture';
import { createTestDb } from './helpers/testDb';

describe('verified native archive graphics', () => {
  let db: Db, close: () => Promise<void>, runtime: NativeRuntime;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    await db.insert(user).values(nativeAdmin);
    runtime = createNativeRuntime(db, new InMemoryStore());
  });
  afterAll(async () => {
    await runtime.shutdown();
    await close();
  });
  const caller = (actor: typeof nativeAdmin | null) =>
    appRouter.createCaller({
      db,
      user: actor,
      nativeRuntime: runtime,
      env: loadEnv({ DATABASE_URL: 'pglite://memory', NODE_ENV: 'test' }),
      challonge: new ChallongeClient({}),
      recomputeTrigger: new RecomputeTrigger(db),
    });

  async function completeKnockout({
    structure = 'single_elimination',
    entrants = 4,
    doubles = false,
    reset = false,
  }: {
    structure?: 'single_elimination' | 'double_elimination';
    entrants?: number;
    doubles?: boolean;
    reset?: boolean;
  } = {}) {
    const members = await db
      .insert(players)
      .values(
        Array.from({ length: entrants * (doubles ? 2 : 1) }, (_, i) => ({
          canonicalName: `Registered ${crypto.randomUUID()}`,
          displayName: `Entrant ${i}`,
        })),
      )
      .returning();
    const admin = caller(nativeAdmin);
    const { planId } = await admin.admin.eventPlanner.createPlan({
      name: 'Verified archive finals',
      eventDate: '2026-10-22T12:00:00Z',
      structure,
      competitionFormat: doubles ? 'doubles' : 'singles',
      rows: doubles
        ? []
        : members.map((member, i) => ({
            lineNumber: i + 1,
            rawInput: member.canonicalName,
            cleanedName: member.canonicalName,
            companyId: null,
            playerId: member.id,
            resolutionMethod: 'manual',
          })),
    });
    if (doubles)
      for (let i = 0; i < entrants; i++)
        await admin.admin.eventPlanner.addDoublesPair({
          planId,
          playerId: members[i * 2]!.id,
          partnerPlayerId: members[i * 2 + 1]!.id,
          teamName: `Team ${i}`,
        });
    await admin.admin.eventPlanner.freezeRoster({ planId });
    await admin.admin.eventPlanner.generatePools({ planId });
    await admin.eventOps.softLockPools({ planId, confirm: true });
    for (;;) {
      const ready = (await runtime.state(planId)).matches.find((match) => match.status === 'ready');
      if (!ready) break;
      const upset = reset && ready.bracketLane === 'final';
      await admin.eventOps.reportScore({
        matchId: ready.id,
        expectedRevision: ready.revision,
        requestId: crypto.randomUUID(),
        score1: upset ? 0 : 2,
        score2: upset ? 2 : 0,
        outcome: 'played',
      });
    }
    await admin.eventOps.native.finalize({ planId });
    return { planId, sealed: await runtime.state(planId) };
  }

  it('uses the addressed tournament revision, follows the latest event revision, and hides withdrawn results', async () => {
    const { planId, sealed } = await completeKnockout();
    const admin = caller(nativeAdmin);
    const publicApi = caller(null).public;
    const planner = admin.admin.eventPlanner;
    const final = sealed.matches.find(({ round }) => round === 2)!;
    await admin.eventOps.live.command({
      planId,
      requestId: 'correct-terminal-winner',
      command: {
        kind: 'replaceResult',
        resultId: sealed.result!.id,
        reason: 'Reviewed terminal winner',
        corrections: [
          {
            matchId: final.id,
            expectedRevision: final.revision,
            outcome: 'played',
            score1: 0,
            score2: 2,
          },
        ],
      },
    });
    const corrected = await runtime.state(planId);
    const [first] = await db
      .select()
      .from(tournaments)
      .where(eq(tournaments.id, sealed.publication!.tournamentIds[0]!));
    const [second] = await db
      .select()
      .from(tournaments)
      .where(eq(tournaments.id, corrected.publication!.tournamentIds[0]!));
    const read = (slug: string) => publicApi.tournament({ slug });
    const prior = (await read(first!.challongeSlug))!;
    const latest = (await read(second!.challongeSlug))!;
    expect(prior.bracketGraphic).toMatchObject({
      revision: 1,
      matches: expect.arrayContaining([
        expect.objectContaining({ label: 'Final', score1: 2, score2: 0 }),
      ]),
    });
    expect(latest.bracketGraphic).toMatchObject({
      revision: 2,
      matches: expect.arrayContaining([
        expect.objectContaining({ label: 'Final', score1: 0, score2: 2 }),
      ]),
    });
    const graphicFinal = latest.bracketGraphic!.matches.find(({ label }) => label === 'Final')!;
    expect(graphicFinal.winnerId).toBe(graphicFinal.player2Id);
    expect(graphicFinal.player2Name).toMatch(/^Entrant /);
    expect(latest.sets.some(({ id }) => id === graphicFinal.parent1MatchId)).toBe(true);
    expect(JSON.stringify(latest.bracketGraphic)).not.toMatch(
      /canonicalName|sourceKey|eventMatchId|resultCommandId|Registered [0-9a-f-]{36}/,
    );

    const overview = await publicApi.eventOverview({ slug: first!.challongeSlug });
    expect(overview?.brackets).toMatchObject([
      { slug: second!.challongeSlug, bracketGraphic: latest.bracketGraphic },
    ]);

    const preview = await planner.recoveryPreview({ planId });
    await planner.recoverPlan({
      planId,
      operation: 'delete',
      withdrawResults: true,
      reason: 'Rehearsal was entered by mistake',
      requestId: crypto.randomUUID(),
      token: preview.token,
    });
    expect(await read(first!.challongeSlug)).toBeNull();
    expect(await read(second!.challongeSlug)).toBeNull();
    expect(await publicApi.eventOverview({ slug: first!.challongeSlug })).toBeNull();
  });

  it('withholds an archive graphic when a sealed draw is missing a feeder', async () => {
    const { sealed } = await completeKnockout();
    const publicApi = caller(null).public;
    const prior = sealed.result!;
    const invalid = {
      ...structuredClone(prior),
      id: crypto.randomUUID(),
      revision: 2,
      replacesResultId: prior.id,
    };
    invalid.matches.find(({ round }) => round === 2)!.parent1Id = null;
    const receipt = await publishNativeResult(db, invalid);
    const [tournament] = await db
      .select()
      .from(tournaments)
      .where(eq(tournaments.id, receipt.tournamentIds[0]!));
    const slug = tournament!.challongeSlug;
    const incomplete = await publicApi.tournament({ slug });
    expect(incomplete?.sets).toHaveLength(3);
    expect(incomplete?.bracketGraphic).toBeUndefined();
    const event = await publicApi.eventOverview({ slug });
    expect(event?.brackets[0]?.bracketGraphic).toBeUndefined();
  });

  it.each([false, true])(
    'keeps double-elimination loser feeds and only played resets (reset=%s)',
    async (reset) => {
      const { sealed } = await completeKnockout({
        structure: 'double_elimination',
        entrants: 3,
        doubles: true,
        reset,
      });
      const [tournament] = await db
        .select()
        .from(tournaments)
        .where(eq(tournaments.id, sealed.publication!.tournamentIds[0]!));
      const archive = await caller(null).public.tournament({ slug: tournament!.challongeSlug });
      const graphic = archive?.bracketGraphic;
      expect(graphic?.format).toBe('doubles');
      expect(graphic?.matches.some(({ outcome }) => outcome === 'bye')).toBe(true);
      expect(
        graphic?.matches.some(
          ({ parent1Outcome, parent2Outcome }) =>
            parent1Outcome === 'loser' || parent2Outcome === 'loser',
        ),
      ).toBe(true);
      expect(graphic?.matches.some(({ bracketLane }) => bracketLane === 'reset')).toBe(reset);
      expect(graphic?.matches.find(({ player1Name }) => player1Name)?.player1Name).toMatch(
        /^Team \d \(Entrant \d \/ Entrant \d\)$/,
      );
    },
  );
});
