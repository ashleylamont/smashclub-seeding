/**
 * Dumps raw Challonge API payloads to disk, losslessly.
 *
 * Why this exists: the legacy CLI's `.challonge-cache` stores only
 * `Date, Tournament, Player 1, Player 2, Winner`, discarding game scores, seeds,
 * rounds and final ranks. Game scores in particular are real information — a
 * 3-0 says more than a 2-1 — and roughly the only untapped signal left in a
 * dataset this small. This keeps everything, so the evaluation harness can
 * measure whether margin-of-victory actually helps before we build on it.
 *
 * Usage (needs network access to Challonge and API credentials):
 *   export CHALLONGE_USERNAME=... CHALLONGE_API_KEY=...
 *   pnpm challonge-dump --out ./challonge-raw --slugs slugs.txt
 *   pnpm challonge-dump --out ./challonge-raw techinplace8 techinplace8rookies
 *
 * Writes one JSON file per tournament containing the untouched tournament,
 * participants and matches payloads. Contains real player names, so treat the
 * output as private — it is gitignored.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { normalizeTournamentId } from '@smashclub/engine';

const API_BASE = 'https://api.challonge.com/v1';

async function requestJson(url: string, auth: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', Authorization: `Basic ${auth}`, 'User-Agent': 'smashclub-dump/1.0' },
  });
  if (!response.ok) {
    const body = (await response.text().catch(() => '')).slice(0, 200);
    throw new Error(`${response.status} ${url}\n  ${body}`);
  }
  return response.json();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { out: { type: 'string' }, slugs: { type: 'string' } },
    strict: false,
  });

  const username = process.env.CHALLONGE_USERNAME;
  const apiKey = process.env.CHALLONGE_API_KEY;
  if (!username || !apiKey) {
    console.error('Set CHALLONGE_USERNAME and CHALLONGE_API_KEY in the environment.');
    process.exit(1);
  }
  const outDir = values.out ? String(values.out) : './challonge-raw';

  const slugs = [
    ...positionals.filter((p) => p !== '--'),
    ...(values.slugs
      ? readFileSync(String(values.slugs), 'utf8')
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith('#'))
      : []),
  ].map((slug) => normalizeTournamentId(slug));

  if (slugs.length === 0) {
    console.error('Pass tournament slugs as arguments, or --slugs <file> (one per line, # comments allowed).');
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });
  const auth = Buffer.from(`${username}:${apiKey}`).toString('base64');
  let ok = 0;
  const failures: string[] = [];

  for (const slug of slugs) {
    try {
      // Polite spacing: Challonge's v1 rate limits are undocumented.
      const tournament = await requestJson(`${API_BASE}/tournaments/${slug}.json`, auth);
      await sleep(600);
      const participants = await requestJson(`${API_BASE}/tournaments/${slug}/participants.json`, auth);
      await sleep(600);
      const matches = await requestJson(`${API_BASE}/tournaments/${slug}/matches.json`, auth);
      await sleep(600);

      const file = path.join(outDir, `${slug.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`);
      writeFileSync(
        file,
        JSON.stringify({ dumpVersion: 1, slug, tournament, participants, matches }, null, 2),
      );
      const matchCount = Array.isArray(matches) ? matches.length : 0;
      const withScores = Array.isArray(matches)
        ? matches.filter((m) => {
            const scores = (m as { match?: { scores_csv?: unknown } }).match?.scores_csv;
            return typeof scores === 'string' && scores.length > 0;
          }).length
        : 0;
      console.log(`✓ ${slug}: ${matchCount} matches (${withScores} with game scores) → ${file}`);
      ok += 1;
    } catch (error) {
      console.error(`✗ ${slug}: ${String(error)}`);
      failures.push(slug);
    }
  }

  console.log(`\ndumped ${ok}/${slugs.length} tournaments to ${outDir}`);
  if (failures.length) {
    console.log(`failed: ${failures.join(', ')}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
