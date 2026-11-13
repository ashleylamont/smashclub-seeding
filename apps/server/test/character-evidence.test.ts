import { afterAll, beforeAll, expect, it } from 'vitest';
import { InMemoryStore } from '@rotorsoft/act';
import {
  playerClaims,
  players,
  sets,
  tournamentParticipants,
  tournaments,
  user,
  type Db,
} from '@smashclub/db';
import { eq } from 'drizzle-orm';
import { createTestDb } from './helpers/testDb';
import { nativeAdmin, seedNativeDraft } from './helpers/nativeLiveFixture';
import { createNativeRuntime, type NativeRuntime } from '../src/tournament/runtime';
import { reportPlayedCharacters } from '../src/players/reportPlayedCharacters';
import {
  archiveCharacterEvidence,
  archiveCharacterLeaders,
} from '../src/events/archivedCharacters';
import { loadEventOverview } from '../src/events/overview';
import { leadingCharacters } from '../src/players/characterEvidence';
import { nativeCharacterEvidence } from '../src/players/nativeCharacterEvidence';
import { missingMainsByMatch, confirmMatchMain } from '../src/tournament/matchMains';
import { setPlayerCharacters, charactersForPlayer } from '../src/players/characters';
import { appRouter } from '../src/trpc/router';
import { loadEnv } from '../src/env';
import { ChallongeClient } from '../src/challonge/client';
import { RecomputeTrigger } from '../src/recompute/trigger';

const player = { id: 'reporter', name: 'Alex', email: 'alex@example.test', role: 'user' as const };
const other = { id: 'other', name: 'Jordan', email: 'jordan@example.test', role: 'user' as const };
let db: Db;
let close: () => Promise<void>;
let runtime: NativeRuntime;

function caller(actor: typeof player | typeof nativeAdmin | null) {
  return appRouter.createCaller({
    db,
    nativeRuntime: runtime,
    user: actor,
    env: loadEnv({ DATABASE_URL: 'pglite://memory', NODE_ENV: 'test' }),
    challonge: new ChallongeClient({}),
    recomputeTrigger: new RecomputeTrigger(db),
  });
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  runtime = createNativeRuntime(db, new InMemoryStore());
  await db.insert(user).values([player, other, nativeAdmin]);
});
afterAll(async () => {
  await runtime.shutdown();
  await close();
});

it('allows a verified archive participant to add and revise picks, with conflicts omitted from histories and graphics', async () => {
  const [a, b, outsider] = await db
    .insert(players)
    .values([
      { canonicalName: 'Private Alex', displayName: 'Alex' },
      { canonicalName: 'Private Jordan', displayName: 'Jordan' },
      { canonicalName: 'Private Outsider', displayName: 'Outsider' },
    ])
    .returning();
  await setPlayerCharacters(db, a!.id, ['kirby']);
  const [tournament] = await db
    .insert(tournaments)
    .values({
      name: 'Upper Main',
      eventDate: new Date('2026-10-03'),
      challongeSlug: 'fighters-test',
      challongeState: 'complete',
      syncState: 'synced',
    })
    .returning();
  const [first, second] = await db
    .insert(tournamentParticipants)
    .values([
      {
        tournamentId: tournament!.id,
        playerId: a!.id,
        challongeParticipantId: 1,
        cleanedName: 'Alex',
        rawName: 'Alex',
        finalRank: 1,
      },
      {
        tournamentId: tournament!.id,
        playerId: b!.id,
        challongeParticipantId: 2,
        cleanedName: 'Jordan',
        rawName: 'Jordan',
        finalRank: 2,
      },
    ])
    .returning();
  const [played, forfeit] = await db
    .insert(sets)
    .values([
      {
        tournamentId: tournament!.id,
        challongeMatchId: 1,
        p1ParticipantId: first!.id,
        p2ParticipantId: second!.id,
        p1PlayerId: a!.id,
        p2PlayerId: b!.id,
        state: 'complete',
        winner: 1,
        scoresCsv: '2-1',
      },
      {
        tournamentId: tournament!.id,
        challongeMatchId: 2,
        p1ParticipantId: first!.id,
        p2ParticipantId: second!.id,
        state: 'complete',
        winner: 1,
        raw: { outcome: 'forfeit' },
      },
    ])
    .returning();
  const input = {
    target: { kind: 'archive' as const, setId: played!.id },
    picks: [{ playerId: a!.id, characters: ['fox'] }],
  };
  await db.insert(playerClaims).values([
    { userId: player.id, playerId: a!.id, status: 'pending' },
    { userId: other.id, playerId: b!.id, status: 'approved' },
  ]);
  await expect(reportPlayedCharacters(db, player, runtime, input)).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
  await db
    .update(playerClaims)
    .set({ status: 'approved' })
    .where(eq(playerClaims.userId, player.id));
  await expect(
    reportPlayedCharacters(db, player, runtime, {
      ...input,
      picks: [{ playerId: outsider!.id, characters: ['fox'] }],
    }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  await expect(
    reportPlayedCharacters(db, player, runtime, {
      ...input,
      target: { kind: 'archive', setId: forfeit!.id },
    }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(caller(null).me.reportPlayedCharacters(input)).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  });
  await expect(
    caller(player).me.reportPlayedCharacters({
      ...input,
      picks: [{ playerId: a!.id, characters: ['not-a-fighter'] }],
    }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  await caller(player).me.reportPlayedCharacters(input);
  await reportPlayedCharacters(db, other, runtime, input);
  const graphic = async () =>
    (await loadEventOverview(db, tournament!.challongeSlug, runtime))!.brackets[0]!.players.find(
      ({ playerId }) => playerId === a!.id,
    )?.graphic?.members[0]?.character;
  expect(await graphic()).toBe('fox');
  const publicSet = (await caller(null).public.tournament({
    slug: tournament!.challongeSlug,
  }))!.sets.find(({ id }) => id === played!.id)!;
  expect(publicSet.charactersPlayed?.picks).toEqual(input.picks);
  expect(JSON.stringify(publicSet)).not.toMatch(/reporter|example.test|Private Alex/);
  expect(await archiveCharacterEvidence(db, [played!, forfeit!], runtime)).toEqual(
    new Map([
      [
        played!.id,
        {
          key: played!.id,
          players: [
            { id: a!.id, name: 'Alex' },
            { id: b!.id, name: 'Jordan' },
          ],
          picks: input.picks,
        },
      ],
    ]),
  );
  const revised = { ...input, picks: [{ playerId: a!.id, characters: ['falco'] }] };
  await reportPlayedCharacters(db, other, runtime, revised);
  expect(await graphic()).toBe('kirby');
  await reportPlayedCharacters(db, player, runtime, revised);
  expect(await graphic()).toBe('falco');
  expect(await charactersForPlayer(db, a!.id)).toEqual(['kirby']);
  expect((await db.select().from(sets).where(eq(sets.id, played!.id)))[0]).toEqual(played);
});

it('counts duplicate archive copies once and leaves tied fighters unset', () => {
  const fox = [{ playerId: 'alex', characters: ['fox'] }];
  const falco = [{ playerId: 'alex', characters: ['falco'] }];
  const set = (key: string, picks: typeof fox) => ({ key, picks, players: [] });
  const one = set('first', fox);
  expect(archiveCharacterLeaders([one, one]).get('alex')).toEqual({ character: 'fox', sets: 1 });
  expect(archiveCharacterLeaders([one, one, set('second', falco)]).has('alex')).toBe(false);
  expect(archiveCharacterLeaders([one, set('first', falco)]).has('alex')).toBe(false);
});

it('uses one vote per native played set and only saves a suggested main after TO confirmation', async () => {
  const planId = await seedNativeDraft(db);
  await runtime.lock(nativeAdmin, planId);
  const before = await runtime.state(planId);
  const first = before.matches[0]!;
  const id = first.player1Id!;
  const [second, third] = before.matches.filter(
    (m) => m.id !== first.id && [m.player1Id, m.player2Id].includes(id),
  );
  const picks = [{ playerId: id, characters: ['fox'] }];
  const score = (match: typeof first) =>
    runtime.command(nativeAdmin, planId, match.id, {
      kind: 'score',
      matchId: match.id,
      expectedRevision: match.revision,
      score1: 2,
      score2: 0,
      outcome: 'played',
      characterPicks: picks,
    });
  await score(first);
  await reportPlayedCharacters(db, nativeAdmin, runtime, {
    target: { kind: 'native', planId, matchId: first.id },
    picks,
  });
  const one = await nativeCharacterEvidence(db, await runtime.state(planId));
  expect(leadingCharacters(one.values()).get(id)).toEqual({ character: 'fox', sets: 1 });
  expect(leadingCharacters(one.values(), 2).has(id)).toBe(false);
  await score(second!);
  const current = await runtime.state(planId);
  const playing = current.matches.find(({ id }) => id === third!.id)!;
  // Use the existing organiser transition for an actually playing match.
  Object.assign(playing, { status: 'playing', started: true });
  const evidence = await nativeCharacterEvidence(db, current);
  const candidates = await missingMainsByMatch(db, current, evidence.values());
  expect(candidates[playing.id]).toContainEqual(
    expect.objectContaining({
      playerId: id,
      suggestion: { character: 'fox', sets: 2 },
    }),
  );
  expect(await charactersForPlayer(db, id)).toEqual([]);
  await confirmMatchMain(db, async () => current, {
    matchId: playing.id,
    playerId: id,
    character: 'fox',
  });
  expect(await charactersForPlayer(db, id)).toEqual(['fox']);
});
