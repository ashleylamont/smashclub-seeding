import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { companies, playerClaims, players, user, type Db } from '@smashclub/db';
import { loadEnv } from '../src/env';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { appRouter } from '../src/trpc/router';
import { createTestDb } from './helpers/testDb';
import { jevClaimCases } from './fixtures/jevClaimCases';
import { fixtureClient } from './helpers/challongeFixtures';

let db: Db;
let close: () => Promise<void>;
let playerId: string;

const account = {
  id: 'claimant',
  name: 'Robin Lark',
  email: 'robin@personal.example',
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

function caller({ enabled = true, admin = false, auto = false, minimum = '0.80' } = {}) {
  return appRouter.createCaller({
    db,
    env: loadEnv({
      DATABASE_URL: 'postgres://unused',
      JEV_CLAIM_REVIEW_ENABLED: String(enabled),
      TYPESAFE_API_KEY: 'fixture-only',
      JEV_CLAIM_AUTO_APPROVE_ENABLED: String(auto),
      JEV_CLAIM_AUTO_APPROVE_MIN_CONFIDENCE: minimum,
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
  expect((await player.me.whoami()).claimReviewMode).toBe('triage');
  const { claimId } = await player.me.requestClaim({
    playerId,
    reviewWithJev: 'triage',
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
  await player.me.requestClaim({ playerId, reviewWithJev: 'auto' });
  expect(fakeFetch).toHaveBeenCalledTimes(1);
});

it.each(['disabled', 'no consent', 'unverified'] as const)(
  'saves claims for manual review without sending data when %s',
  async (scenario) => {
    if (scenario === 'unverified') {
      await db.update(user).set({ emailVerified: false }).where(eq(user.id, account.id));
    }
    const player = caller({ enabled: scenario !== 'disabled' });
    await player.me.requestClaim({
      playerId,
      reviewWithJev: scenario === 'no consent' ? undefined : 'auto',
    });
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
  await caller().me.requestClaim({ playerId, reviewWithJev: 'auto', note: ' ' });
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
    await caller().me.requestClaim({ playerId, reviewWithJev: 'auto' });
    expect(await caller({ admin: true }).admin.claims()).toMatchObject([
      { status: 'pending', jevReview: { result: 'unavailable' } },
    ]);
  },
);

function usePerfectScore() {
  const perfectScore = structuredClone(score);
  perfectScore.answers.player_profile_match = {
    type: 'score',
    score: 4,
    confidence: 1,
    probabilities: { '0': 0, '1': 0, '2': 0, '3': 0, '4': 1 },
  };
  fakeFetch.mockImplementationOnce(async () => Response.json(perfectScore));
}

it('auto-approves a high-confidence claim from a verified personal email', async () => {
  usePerfectScore();
  const player = caller({ auto: true });
  expect((await player.me.whoami()).claimReviewMode).toBe('auto');
  const { claimId } = await player.me.requestClaim({
    playerId,
    reviewWithJev: 'auto',
    note: 'A note reserved for the administrator when auto-approval is possible.',
  });
  expect(JSON.parse(String(fakeFetch.mock.calls[0]?.[1]?.body)).state).not.toHaveProperty(
    'claimantNote',
  );
  expect((await player.me.claims())[0]).toMatchObject({ id: claimId, status: 'approved' });
  expect(await caller({ admin: true }).admin.claims()).toMatchObject([
    { status: 'approved', autoApproved: true, jevReview: { autoApprovedAt: expect.any(String) } },
  ]);
  await expect(
    player.me.updateDisplayName({ playerId, displayName: 'Another name' }),
  ).resolves.toEqual({ ok: true });
  await caller({ admin: true }).admin.resolveClaim({ claimId, action: 'revoked' });
  expect((await player.me.claims())[0]).toMatchObject({ status: 'revoked' });
});

it.each([
  'unverified email',
  'auto disabled',
  'advisory consent only',
  'low confidence',
  'low score',
  'previous admin decision',
  'another claimant',
  'email changed during review',
] as const)('keeps the claim pending when there is %s', async (scenario) => {
  if (scenario === 'low confidence' || scenario === 'low score') {
    const response = structuredClone(score);
    response.answers.player_profile_match =
      scenario === 'low confidence'
        ? { ...response.answers.player_profile_match, confidence: 0.72 }
        : {
            type: 'score',
            score: 0,
            confidence: 1,
            probabilities: { '0': 1, '1': 0, '2': 0, '3': 0, '4': 0 },
          };
    fakeFetch.mockImplementationOnce(async () => Response.json(response));
  } else {
    usePerfectScore();
  }
  if (scenario === 'unverified email') {
    await db.update(user).set({ emailVerified: false }).where(eq(user.id, account.id));
  }
  if (scenario === 'previous admin decision') {
    await db.insert(playerClaims).values({
      userId: account.id,
      playerId,
      status: 'rejected',
      resolvedBy: account.id,
      createdAt: new Date(0),
    });
  }
  if (scenario === 'another claimant') {
    await db.insert(user).values({ ...account, id: 'other', email: 'other@example.test' });
    await db.insert(playerClaims).values({ userId: 'other', playerId });
  }
  if (scenario === 'email changed during review') {
    fakeFetch.mockReset().mockImplementation(async () => {
      await db.update(user).set({ email: 'robin@other.example' }).where(eq(user.id, account.id));
      return Response.json({
        ...score,
        answers: {
          player_profile_match: {
            ...score.answers.player_profile_match,
            score: 4,
            confidence: 1,
            probabilities: { '0': 0, '1': 0, '2': 0, '3': 0, '4': 1 },
          },
        },
      });
    });
  }

  const player = caller({ auto: scenario !== 'auto disabled' });
  await player.me.requestClaim({
    playerId,
    reviewWithJev: scenario === 'advisory consent only' ? 'triage' : 'auto',
  });
  expect((await player.me.claims())[0]).toMatchObject({ status: 'pending' });
});

it.each(jevClaimCases)('applies the configured policy to $label', async (fixture) => {
  await db.update(user).set(fixture.state.account).where(eq(user.id, account.id));
  await db
    .update(players)
    .set({ displayName: fixture.state.profile.name })
    .where(eq(players.id, playerId));
  await db
    .update(companies)
    .set({ name: fixture.state.profile.company ?? 'Example Company' })
    .where(eq(companies.code, 'JEV'));
  if (!fixture.state.profile.company) {
    await db.update(players).set({ companyId: null }).where(eq(players.id, playerId));
  }
  const response = structuredClone(score);
  response.answers.player_profile_match = {
    type: 'score',
    score: fixture.mockProbabilities.reduce(
      (total, probability, level) => total + probability * level,
      0,
    ),
    confidence: fixture.mockConfidence,
    probabilities: {
      '0': fixture.mockProbabilities[0],
      '1': fixture.mockProbabilities[1],
      '2': fixture.mockProbabilities[2],
      '3': fixture.mockProbabilities[3],
      '4': fixture.mockProbabilities[4],
    },
  };
  fakeFetch.mockImplementationOnce(async () => Response.json(response));
  const player = caller({ auto: true });
  await player.me.requestClaim({ playerId, reviewWithJev: 'auto' });
  expect(JSON.parse(String(fakeFetch.mock.calls[0]?.[1]?.body)).state).toEqual(fixture.state);
  expect((await player.me.claims())[0]?.status).toBe(fixture.autoApprove ? 'approved' : 'pending');
});
