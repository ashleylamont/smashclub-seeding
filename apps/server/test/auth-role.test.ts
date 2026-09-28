import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { user, type Db } from '@smashclub/db';
import { buildApp } from '../src/app';
import { createAuth, getSessionUser, type Auth, type SessionUser } from '../src/auth';
import { loadEnv, type Env } from '../src/env';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { appRouter } from '../src/trpc/router';
import { createTestDb } from './helpers/testDb';
import { fixtureClient } from './helpers/challongeFixtures';

const ADMIN_EMAIL = 'admin@example.com';
const PLAYER_EMAIL = 'player@example.com';
const PASSWORD = 'test-password-123';

let db: Db;
let close: () => Promise<void>;
let auth: Auth;

function envWith(adminEmails: string): Env {
  return loadEnv({
    NODE_ENV: 'test', DATABASE_URL: 'postgres://unused',
    BETTER_AUTH_SECRET: 'test-secret-test-secret-test', ADMIN_EMAILS: adminEmails,
  });
}

async function signIn(email: string): Promise<Headers> {
  await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: 'Test' } });
  const response = await auth.api.signInEmail({ body: { email, password: PASSWORD }, asResponse: true });
  const cookie = response.headers.getSetCookie().map((entry) => entry.split(';')[0]).join('; ');
  return new Headers({ cookie });
}

async function markVerified(email: string, verified: boolean): Promise<void> {
  await db.update(user).set({ emailVerified: verified }).where(eq(user.email, email));
}

async function stored(email: string) {
  const [row] = await db.select({ id: user.id, role: user.role }).from(user).where(eq(user.email, email));
  return row!;
}

function adminApi(actor: SessionUser) {
  return appRouter.createCaller({
    db, env: envWith(ADMIN_EMAIL), user: actor,
    challonge: fixtureClient([]), recomputeTrigger: new RecomputeTrigger(db, 60_000, () => {}),
  }).admin;
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  auth = createAuth(db, envWith(ADMIN_EMAIL), { enableCredentials: true });
});

afterEach(async () => { await close(); });

describe('admin account management', () => {
  it('bootstraps a verified first admin, then keeps the database role when the env list changes', async () => {
    const headers = await signIn(ADMIN_EMAIL);
    await markVerified(ADMIN_EMAIL, true);
    expect((await getSessionUser(auth, db, envWith(ADMIN_EMAIL), headers))?.role).toBe('admin');
    expect((await getSessionUser(auth, db, envWith(''), headers))?.role).toBe('admin');
  });

  it('does not bootstrap an unverified address or promote another env address after an admin exists', async () => {
    const adminHeaders = await signIn(ADMIN_EMAIL);
    expect((await getSessionUser(auth, db, envWith(ADMIN_EMAIL), adminHeaders))?.role).toBe('user');
    await markVerified(ADMIN_EMAIL, true);
    expect((await getSessionUser(auth, db, envWith(ADMIN_EMAIL), adminHeaders))?.role).toBe('admin');
    const playerHeaders = await signIn(PLAYER_EMAIL);
    await markVerified(PLAYER_EMAIL, true);
    expect((await getSessionUser(auth, db, envWith(`${ADMIN_EMAIL},${PLAYER_EMAIL}`), playerHeaders))?.role).toBe('user');
  });

  it('can recover bootstrap access if the only stored admin loses email verification', async () => {
    const adminHeaders = await signIn(ADMIN_EMAIL);
    await markVerified(ADMIN_EMAIL, true);
    expect((await getSessionUser(auth, db, envWith(ADMIN_EMAIL), adminHeaders))?.role).toBe('admin');
    await markVerified(ADMIN_EMAIL, false);
    expect((await getSessionUser(auth, db, envWith(ADMIN_EMAIL), adminHeaders))?.role).toBe('user');

    const playerHeaders = await signIn(PLAYER_EMAIL);
    await markVerified(PLAYER_EMAIL, true);
    expect((await getSessionUser(auth, db, envWith(PLAYER_EMAIL), playerHeaders))?.role).toBe('admin');
  });

  it('promotes and removes a verified account through the admin API, including its open session', async () => {
    const adminHeaders = await signIn(ADMIN_EMAIL);
    await markVerified(ADMIN_EMAIL, true);
    const actor = (await getSessionUser(auth, db, envWith(ADMIN_EMAIL), adminHeaders))!;
    const playerHeaders = await signIn(PLAYER_EMAIL);
    await markVerified(PLAYER_EMAIL, true);
    const player = await stored(PLAYER_EMAIL);

    await adminApi(actor).setAdminRole({ userId: player.id, admin: true });
    expect((await getSessionUser(auth, db, envWith(''), playerHeaders))?.role).toBe('admin');
    await adminApi(actor).setAdminRole({ userId: player.id, admin: false });
    expect((await getSessionUser(auth, db, envWith(ADMIN_EMAIL), playerHeaders))?.role).toBe('user');
    expect((await stored(PLAYER_EMAIL)).role).toBe('user');
  });

  it('does not regrant a removed bootstrap admin while ADMIN_EMAILS still names them', async () => {
    const adminHeaders = await signIn(ADMIN_EMAIL);
    await markVerified(ADMIN_EMAIL, true);
    const actor = (await getSessionUser(auth, db, envWith(ADMIN_EMAIL), adminHeaders))!;
    const playerHeaders = await signIn(PLAYER_EMAIL);
    await markVerified(PLAYER_EMAIL, true);
    const player = await stored(PLAYER_EMAIL);
    await adminApi(actor).setAdminRole({ userId: player.id, admin: true });
    const promoted = (await getSessionUser(auth, db, envWith(ADMIN_EMAIL), playerHeaders))!;

    await adminApi(promoted).setAdminRole({ userId: actor.id, admin: false });
    expect((await getSessionUser(auth, db, envWith(ADMIN_EMAIL), adminHeaders))?.role).toBe('user');
    expect((await stored(ADMIN_EMAIL)).role).toBe('user');
  });

  it('rejects promotion before verification and removal of the last admin', async () => {
    const adminHeaders = await signIn(ADMIN_EMAIL);
    await markVerified(ADMIN_EMAIL, true);
    const actor = (await getSessionUser(auth, db, envWith(ADMIN_EMAIL), adminHeaders))!;
    await signIn(PLAYER_EMAIL);
    const player = await stored(PLAYER_EMAIL);
    await expect(adminApi(actor).setAdminRole({ userId: player.id, admin: true }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(adminApi(actor).setAdminRole({ userId: actor.id, admin: false }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('keeps admin discovery and role changes closed to ordinary accounts', async () => {
    await signIn(PLAYER_EMAIL);
    const player = await stored(PLAYER_EMAIL);
    const caller = adminApi({ id: player.id, email: PLAYER_EMAIL, name: 'Player', role: 'user' });
    await expect(caller.admins()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.findAccounts({ search: 'admin' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.setAdminRole({ userId: player.id, admin: true }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('closes admin procedures to a removed admin over HTTP without signing them out', async () => {
    const adminHeaders = await signIn(ADMIN_EMAIL);
    await markVerified(ADMIN_EMAIL, true);
    const actor = (await getSessionUser(auth, db, envWith(ADMIN_EMAIL), adminHeaders))!;
    const playerHeaders = await signIn(PLAYER_EMAIL);
    await markVerified(PLAYER_EMAIL, true);
    const player = await stored(PLAYER_EMAIL);
    await adminApi(actor).setAdminRole({ userId: player.id, admin: true });

    const app = await buildApp({ db, env: envWith(ADMIN_EMAIL), auth,
      challonge: fixtureClient([]), recomputeTrigger: new RecomputeTrigger(db) });
    const cookie = playerHeaders.get('cookie')!;
    const before = await app.inject({ method: 'GET', url: '/api/trpc/admin.reviewQueue', headers: { cookie } });
    expect(before.statusCode).toBe(200);
    await adminApi(actor).setAdminRole({ userId: player.id, admin: false });
    const after = await app.inject({ method: 'GET', url: '/api/trpc/admin.reviewQueue', headers: { cookie } });
    expect(after.statusCode).toBe(403);
    await app.close();
  });
});
