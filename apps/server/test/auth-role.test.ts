import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { user, type Db } from '@smashclub/db';
import { buildApp } from '../src/app';
import { createAuth, getSessionUser, type Auth } from '../src/auth';
import { loadEnv, type Env } from '../src/env';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { createTestDb } from './helpers/testDb';
import { fixtureClient } from './helpers/challongeFixtures';

/**
 * ADMIN_EMAILS is the single source of truth for administrator access, and the
 * `role` column is a cache of it. These tests pin the property that makes that
 * claim true: reconciliation runs in *both* directions, so offboarding is just
 * "take the address out of the list".
 */

const ADMIN_EMAIL = 'admin@example.com';
const PASSWORD = 'test-password-123';

let db: Db;
let close: () => Promise<void>;
let auth: Auth;

function envWith(adminEmails: string): Env {
  return loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://unused',
    BETTER_AUTH_SECRET: 'test-secret-test-secret-test',
    ADMIN_EMAILS: adminEmails,
  });
}

/** Sign up + sign in, returning the request headers a browser would send. */
async function signIn(email: string): Promise<Headers> {
  await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: 'Test' } });
  const response = await auth.api.signInEmail({
    body: { email, password: PASSWORD },
    asResponse: true,
  });
  const cookie = response.headers
    .getSetCookie()
    .map((entry) => entry.split(';')[0])
    .join('; ');
  const headers = new Headers();
  headers.set('cookie', cookie);
  return headers;
}

/** Stand in for the provider-side verification an OAuth sign-in would carry. */
async function markVerified(email: string, verified: boolean): Promise<void> {
  await db.update(user).set({ emailVerified: verified }).where(eq(user.email, email));
}

async function persistedRole(email: string): Promise<string | undefined> {
  const [row] = await db.select({ role: user.role }).from(user).where(eq(user.email, email));
  return row?.role;
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  auth = createAuth(db, envWith(ADMIN_EMAIL), { enableCredentials: true });
});

afterEach(async () => {
  await close();
});

describe('admin role reconciliation', () => {
  it('promotes an allowlisted, verified address', async () => {
    const headers = await signIn(ADMIN_EMAIL);
    await markVerified(ADMIN_EMAIL, true);

    const sessionUser = await getSessionUser(auth, db, envWith(ADMIN_EMAIL), headers);
    expect(sessionUser?.role).toBe('admin');
    expect(await persistedRole(ADMIN_EMAIL)).toBe('admin');
  });

  it('revokes admin when the address is removed from ADMIN_EMAILS', async () => {
    const headers = await signIn(ADMIN_EMAIL);
    await markVerified(ADMIN_EMAIL, true);
    expect((await getSessionUser(auth, db, envWith(ADMIN_EMAIL), headers))?.role).toBe('admin');

    // Offboarding: the address leaves the list. The session is untouched — the
    // same cookie, the same user row — and must lose admin on the next call.
    const sessionUser = await getSessionUser(auth, db, envWith(''), headers);
    expect(sessionUser?.role).toBe('user');
    expect(await persistedRole(ADMIN_EMAIL)).toBe('user');
  });

  it('does not promote an allowlisted address the provider has not verified', async () => {
    const headers = await signIn(ADMIN_EMAIL);
    await markVerified(ADMIN_EMAIL, false);

    const sessionUser = await getSessionUser(auth, db, envWith(ADMIN_EMAIL), headers);
    expect(sessionUser?.role).toBe('user');
    expect(await persistedRole(ADMIN_EMAIL)).toBe('user');
  });

  it('revokes a role that was pinned directly in the database', async () => {
    const headers = await signIn('player@example.com');
    await markVerified('player@example.com', true);
    await db.update(user).set({ role: 'admin' }).where(eq(user.email, 'player@example.com'));

    const sessionUser = await getSessionUser(auth, db, envWith(ADMIN_EMAIL), headers);
    expect(sessionUser?.role).toBe('user');
    expect(await persistedRole('player@example.com')).toBe('user');
  });

  it('closes admin procedures to an offboarded admin over HTTP', async () => {
    const headers = await signIn(ADMIN_EMAIL);
    await markVerified(ADMIN_EMAIL, true);
    const cookie = headers.get('cookie')!;

    const allowlisted = await buildApp({
      db,
      env: envWith(ADMIN_EMAIL),
      auth,
      challonge: fixtureClient([]),
      recomputeTrigger: new RecomputeTrigger(db),
    });
    const before = await allowlisted.inject({ method: 'GET', url: '/api/trpc/admin.reviewQueue', headers: { cookie } });
    expect(before.statusCode).toBe(200);
    await allowlisted.close();

    const offboarded = await buildApp({
      db,
      env: envWith(''),
      auth,
      challonge: fixtureClient([]),
      recomputeTrigger: new RecomputeTrigger(db),
    });
    const after = await offboarded.inject({ method: 'GET', url: '/api/trpc/admin.reviewQueue', headers: { cookie } });
    expect(after.statusCode).toBe(403);
    await offboarded.close();
  });
});
