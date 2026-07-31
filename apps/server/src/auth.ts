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
export function createAuth(db: Db, env: Env, options: { enableCredentials?: boolean } = {}) {
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
    /**
     * Email/password is enabled only by the local dev harness, so the
     * Fastify↔better-auth bridge and the role/claim flows can be exercised
     * end to end without a real OAuth provider. Production uses OAuth only.
     */
    emailAndPassword: { enabled: options.enableCredentials === true },
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ['discord', 'google'],
        /**
         * Identity is the user row, never the email address. Club members
         * routinely sign in with a work Google account and a personal Discord
         * one; with this off, better-auth refuses to link the second provider
         * whenever its email differs, which is exactly the common case. Linking
         * here is always an explicit, authenticated action from /me — the user
         * is already signed in to the account being linked *to* — so the
         * differing address is not a trust boundary being crossed.
         */
        allowDifferentEmails: true,
      },
    },
    user: {
      additionalFields: {
        role: { type: 'string', defaultValue: 'user', input: false },
      },
    },
    databaseHooks: {
      user: {
        create: {
          /**
           * Stamp the admin role at creation for addresses in ADMIN_EMAILS,
           * covering OAuth sign-ups too. Without this the role would only be
           * applied lazily on the first API call, so the client's session (and
           * therefore the admin navigation) would lag a request behind.
           */
          before: async (user: { email?: string }) => {
            if (isAdminEmail(user.email, env)) {
              return { data: { ...user, role: 'admin' } };
            }
            return undefined;
          },
        },
      },
    },
  });
}

function adminEmails(env: Env): string[] {
  return env.ADMIN_EMAILS.split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function isAdminEmail(email: string | undefined, env: Env): boolean {
  return email ? adminEmails(env).includes(email.toLowerCase()) : false;
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

  // Catch-up promotion for accounts created before their address was added to
  // ADMIN_EMAILS; new accounts are stamped by the create hook above.
  if (role !== 'admin' && isAdminEmail(email, env)) {
    await db.update(user).set({ role: 'admin', updatedAt: new Date() }).where(eq(user.id, id));
    role = 'admin';
  }

  return { id, email, name, role: role as 'admin' | 'user' };
}
