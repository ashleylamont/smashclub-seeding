import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { eq } from 'drizzle-orm';
import type { Db } from '@smashclub/db';
import { account, session, user, verification } from '@smashclub/db';
import type { Env } from './env';

export type Auth = ReturnType<typeof createAuth>;

/**
 * better-auth with Discord + Google and multi-provider account linking: a
 * logged-in user can link their other provider from /me, and both providers
 * land on the same user row.
 */
export function createAuth(db: Db, env: Env) {
  const socialProviders: Record<string, { clientId: string; clientSecret: string }> = {};
  if (env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET) {
    socialProviders.discord = { clientId: env.DISCORD_CLIENT_ID, clientSecret: env.DISCORD_CLIENT_SECRET };
  }
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    socialProviders.google = { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
  }

  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    basePath: '/api/auth',
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: { user, session, account, verification },
    }),
    socialProviders,
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ['discord', 'google'],
      },
    },
    user: {
      additionalFields: {
        role: { type: 'string', defaultValue: 'user', input: false },
      },
    },
  });
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'user';
}

/**
 * Resolve the request's session user, promoting ADMIN_EMAILS members to
 * admin on first sight (bootstrap path — no manual SQL for the first admin).
 */
export async function getSessionUser(
  auth: Auth,
  db: Db,
  env: Env,
  headers: Headers,
): Promise<SessionUser | null> {
  const sessionData = await auth.api.getSession({ headers });
  if (!sessionData?.user) return null;
  const { id, email, name } = sessionData.user;
  let role = (sessionData.user as { role?: string }).role === 'admin' ? 'admin' : 'user';

  if (role !== 'admin') {
    const adminEmails = env.ADMIN_EMAILS.split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
    if (adminEmails.includes(email.toLowerCase())) {
      await db.update(user).set({ role: 'admin', updatedAt: new Date() }).where(eq(user.id, id));
      role = 'admin';
    }
  }

  return { id, email, name, role: role as 'admin' | 'user' };
}
