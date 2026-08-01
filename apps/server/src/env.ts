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
  /**
   * Trust `X-Forwarded-*` from the proxy in front of us. Off by default (a
   * directly-exposed server must not let clients pick their own address);
   * turn it on behind the k8s ingress, otherwise every request appears to
   * come from the ingress and the per-IP SSE cap degrades into a second
   * global one.
   */
  TRUST_PROXY: z
    .string()
    .default('false')
    .transform((value) => value === 'true' || value === '1'),
  /**
   * Live-feed admission limits. The SSE routes are public and long-lived, so
   * these are what bound the sockets, bus listeners and timers an anonymous
   * client can make the process hold. See live/sse.ts.
   */
  SSE_MAX_CONNECTIONS: z.coerce.number().int().positive().default(500),
  /**
   * Generous, because it is per *address*: every open tab holds one stream and
   * a live tournament page holds two, so a clubhouse behind one NAT is a
   * handful of streams per person. The global cap is what bounds an attacker;
   * this only stops one host from trivially eating it.
   */
  SSE_MAX_CONNECTIONS_PER_IP: z.coerce.number().int().positive().default(20),
  /** Server-initiated close; EventSource reconnects, so this is invisible. */
  SSE_MAX_STREAM_MS: z.coerce.number().int().positive().default(30 * 60_000),
  /** Close a stream whose unflushed write buffer passes this (slow consumer). */
  SSE_MAX_BUFFERED_BYTES: z.coerce.number().int().positive().default(1_048_576),
  /** Absolute path of the built SPA to serve statically (production). */
  WEB_DIST_DIR: z.string().optional(),
  /** Drizzle SQL migrations folder, applied at startup. */
  MIGRATIONS_DIR: z.string().default('./migrations'),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return envSchema.parse(source);
}
