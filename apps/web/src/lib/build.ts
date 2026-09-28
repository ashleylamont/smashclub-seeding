/*
 * Which build is this?
 *
 * The homelab repo pins this app by image digest, and the image tag is
 * `sha-<short>` — so when prod looks wrong the first question is always "is it
 * even running the build I think it is?". Answering it used to mean reading a
 * kustomize overlay and a deployment. Now the footer says so.
 *
 * `VITE_BUILD_SHA` is statically replaced by Vite at build time, so this costs
 * nothing at runtime and cannot drift from the bundle it ships in. A local
 * `pnpm dev`/`pnpm build` leaves it unset, which reads as "dev".
 */

const sha = import.meta.env.VITE_BUILD_SHA?.trim();

/** Full 40-char git SHA, or null for an unstamped (local) build. */
export const BUILD_SHA: string | null = sha && sha.length > 0 ? sha : null;

/** What the footer shows: the 7-char short SHA, matching the `sha-` image tag. */
export const BUILD_LABEL: string = BUILD_SHA ? BUILD_SHA.slice(0, 7) : 'dev';

/** Commit page for this build, or null when there is no SHA to link to. */
export const BUILD_COMMIT_URL: string | null = BUILD_SHA
  ? `https://github.com/ashleylamont/smashclub-seeding/commit/${BUILD_SHA}`
  : null;
