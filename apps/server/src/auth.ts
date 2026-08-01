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
           * therefore the admin navigation) would lag a request behind. This is
           * purely a latency shortcut — `getSessionUser` reconciles the column
           * against the allowlist on every request regardless.
           */
          before: async (user: { email?: string; emailVerified?: boolean }) => {
            if (isAdminIdentity(user, env)) {
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

/**
 * Whether an account currently qualifies for the admin role.
 *
 * The address must be *verified by the provider*, not merely present on the
 * profile. Discord in particular reports an unverified address for accounts
 * that never confirmed their email (better-auth maps its `verified` flag onto
 * `emailVerified`), and an unverified address is not proof that the person
 * signing in controls the mailbox the club allowlisted.
 */
function isAdminIdentity(account: { email?: string | null; emailVerified?: boolean | null }, env: Env): boolean {
  if (!account.email || account.emailVerified !== true) return false;
  return adminEmails(env).includes(account.email.toLowerCase());
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'user';
}

/**
 * Resolve the request's session user and reconcile its role against
 * ADMIN_EMAILS.
 *
 * ADMIN_EMAILS is the single source of truth for administrator access; the
 * `role` column is a cache of it. Reconciliation runs in *both* directions on
 * every request, so adding an address grants admin on the allowlisted user's
 * next call and removing one revokes it just as promptly — including for a
 * session that is already open, and for any other provider linked to the same
 * account. There is deliberately no way to pin an admin in the database that
 * the allowlist will not revoke: a role the allowlist cannot take back is a
 * role nobody can offboard.
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
  const persisted = (sessionData.user as { role?: string }).role === 'admin' ? 'admin' : 'user';
  const role: 'admin' | 'user' = isAdminIdentity(sessionData.user, env) ? 'admin' : 'user';

  if (role !== persisted) {
    await db.update(user).set({ role, updatedAt: new Date() }).where(eq(user.id, id));
  }

  return { id, email, name, role };
}
