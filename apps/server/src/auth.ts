import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { and, eq } from 'drizzle-orm';
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
  });
}

function adminEmails(env: Env): string[] {
  return env.ADMIN_EMAILS.split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Whether an account can bootstrap the first admin role.
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
 * Resolve the request's session user from the current database row. The auth
 * session may contain an older role after another admin changes it in the UI.
 * ADMIN_EMAILS is used only when no verified admin can sign in; after that,
 * the database role is authoritative.
 */
export async function getSessionUser(
  auth: Auth,
  db: Db,
  env: Env,
  headers: Headers,
): Promise<SessionUser | null> {
  const sessionData = await auth.api.getSession({ headers });
  if (!sessionData?.user) return null;
  const [current] = await db.select({
    id: user.id, email: user.email, name: user.name,
    emailVerified: user.emailVerified, role: user.role,
  }).from(user).where(eq(user.id, sessionData.user.id));
  if (!current) return null;

  if (current.role !== 'admin' && isAdminIdentity(current, env)) {
    const [existingAdmin] = await db.select({ id: user.id }).from(user)
      .where(and(eq(user.role, 'admin'), eq(user.emailVerified, true))).limit(1);
    if (!existingAdmin) {
      const [promoted] = await db.update(user).set({ role: 'admin', updatedAt: new Date() })
        .where(and(eq(user.id, current.id), eq(user.role, 'user'), eq(user.emailVerified, true)))
        .returning({ id: user.id });
      if (promoted) current.role = 'admin';
    }
  }
  return { id: current.id, email: current.email, name: current.name,
    role: current.role === 'admin' && current.emailVerified ? 'admin' : 'user' };
}
