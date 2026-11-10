import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { companies, players, user, type Db } from '@smashclub/db';
import { loadEnv } from '../src/env';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { appRouter } from '../src/trpc/router';
import { createTestDb } from './helpers/testDb';
import { fixtureClient } from './helpers/challongeFixtures';

let db: Db;
let close: () => Promise<void>;
let playerId: string;

const account = {
  id: 'claimant',
  name: 'Robin Lark',
  email: 'robin@example.test',
  role: 'user' as const,
};

const score = {
  model: 'jev-1.14.0',
  answers: {
    player_profile_match: {
      type: 'score',
      score: 3.98,
      confidence: 0.96,
      probabilities: { '0': 0, '1': 0, '2': 0, '3': 0.02, '4': 0.98 },
    },
  },
};

const fakeFetch = vi.fn<typeof fetch>();

function caller({ enabled = true, admin = false } = {}) {
  return appRouter.createCaller({
    db,
    env: loadEnv({
      DATABASE_URL: 'postgres://unused',
      JEV_CLAIM_REVIEW_ENABLED: String(enabled),
      TYPESAFE_API_KEY: 'fixture-only',
    }),
    user: { ...account, role: admin ? 'admin' : account.role },
    challonge: fixtureClient([]),
    recomputeTrigger: new RecomputeTrigger(db, 1_000_000),
  });
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(user).values({ ...account, emailVerified: true });
  const [company] = await db
    .insert(companies)
    .values({ code: 'JEV', name: 'Example Company' })
    .returning();
  const [player] = await db
    .insert(players)
    .values({ canonicalName: 'Private Registry Name', displayName: 'Lark', companyId: company!.id })
    .returning();
  playerId = player!.id;
  fakeFetch.mockReset().mockImplementation(async () => Response.json(score));
  vi.stubGlobal('fetch', fakeFetch);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await close();
});

it('sends only the opted-in evidence and leaves ownership with the admin', async () => {
  const player = caller();
  expect((await player.me.whoami()).claimReviewAvailable).toBe(true);
  const { claimId } = await player.me.requestClaim({
    playerId,
    reviewWithJev: true,
    note: '  My local bracket name is Lark.  ',
  });

  expect(fakeFetch).toHaveBeenCalledTimes(1);
  const [url, request] = fakeFetch.mock.calls[0]!;
  expect(url).toBe('https://api.typesafe.ai/v1/systemone');
  expect(request?.headers).toMatchObject({ Authorization: 'Bearer fixture-only' });
  expect(JSON.parse(String(request?.body)).state).toEqual({
    profile: { name: 'Lark', company: 'Example Company' },
    account: { name: account.name, email: account.email },
    claimantNote: 'My local bracket name is Lark.',
  });

  const admin = caller({ admin: true });
  expect(await admin.admin.claims()).toMatchObject([
    { id: claimId, status: 'pending', jevReview: { result: 'likely_match', score: 3.98 } },
  ]);
  expect((await player.me.claims())[0]).not.toHaveProperty('jevReview');
  await expect(player.admin.claims()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(
    player.me.updateDisplayName({ playerId, displayName: 'Another name' }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });

  await player.me.withdrawClaim({ claimId });
  await player.me.requestClaim({ playerId, reviewWithJev: true });
  expect(fakeFetch).toHaveBeenCalledTimes(1);
});

it.each(['disabled', 'no consent', 'unverified'] as const)(
  'saves claims for manual review without sending data when %s',
  async (scenario) => {
    if (scenario === 'unverified') {
      await db.update(user).set({ emailVerified: false }).where(eq(user.id, account.id));
    }
    const player = caller({ enabled: scenario !== 'disabled' });
    await player.me.requestClaim({ playerId, reviewWithJev: scenario !== 'no consent' });
    expect(fakeFetch).not.toHaveBeenCalled();
    expect(await caller({ admin: true }).admin.claims()).toMatchObject([
      { status: 'pending', jevReview: null },
    ]);
  },
);

it('stores a low-confidence score as inconclusive and omits an empty note', async () => {
  const response = structuredClone(score);
  response.answers.player_profile_match.confidence = 0.4;
  fakeFetch.mockImplementationOnce(async () => Response.json(response));
  await caller().me.requestClaim({ playerId, reviewWithJev: true, note: ' ' });
  expect(JSON.parse(String(fakeFetch.mock.calls[0]?.[1]?.body)).state).not.toHaveProperty(
    'claimantNote',
  );
  expect(await caller({ admin: true }).admin.claims()).toMatchObject([
    { status: 'pending', jevReview: { result: 'manual_review' } },
  ]);
});

it.each(['bad response', 'network error'] as const)(
  'leaves the claim pending if Jev fails with a %s',
  async (scenario) => {
    if (scenario === 'bad response') {
      fakeFetch.mockImplementationOnce(async () => Response.json({ answers: {} }));
    } else {
      fakeFetch.mockRejectedValueOnce(new Error('provider unreachable'));
    }
    await caller().me.requestClaim({ playerId, reviewWithJev: true });
    expect(await caller({ admin: true }).admin.claims()).toMatchObject([
      { status: 'pending', jevReview: { result: 'unavailable' } },
    ]);
  },
);
