import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  CHALLONGE_API_KEY: z.string().optional(),
  CHALLONGE_USERNAME: z.string().optional(),
  BETTER_AUTH_SECRET: z.string().optional(),
  BETTER_AUTH_URL: z.string().optional(),
  DISCORD_CLIENT_ID: z.string().optional(),
  DISCORD_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  /**
   * Comma-separated emails promoted to admin at login. Matched against the
   * account's primary email — the address of the provider used to sign up.
   * Providers linked afterwards may carry different addresses (that is
   * supported and expected) but those addresses are not checked here, so list
   * the one the admin originally signed up with.
   */
  ADMIN_EMAILS: z.string().default(''),
  /** Absolute path of the built SPA to serve statically (production). */
  WEB_DIST_DIR: z.string().optional(),
  /** Drizzle SQL migrations folder, applied at startup. */
  MIGRATIONS_DIR: z.string().default('./migrations'),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return envSchema.parse(source);
}
