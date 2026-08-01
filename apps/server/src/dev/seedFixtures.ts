import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { Db } from '@smashclub/db';
import { players, tournaments } from '@smashclub/db';
import { cleanPlayerEntry, preparePlayerEntry } from '@smashclub/engine';
import type { ChallongeClient } from '../challonge/client';
import { importCompanyTaxonomy, importRegistryPlayers, type RegistryPlayerInput } from '../bootstrap/importRegistry';
import { runRecompute } from '../recompute/recompute';
import { syncTournament } from '../sync/sync';
import { createFixtureClient, type FixtureTournament } from './challongeFixture';
import { Pseudonymiser, characterSlug } from './pseudonyms';

/**
 * Seeds a development database with a believable club, then runs the real sync
 * and recompute pipelines over it.
 *
 * Two sources:
 *   - a real `.challonge-cache` directory (pseudonymised on the way in), which
 *     produces genuinely shaped data — long tail of one-event players, paired
 *     main/rookie brackets, thin crossover;
 *   - a deterministic synthetic generator, used when no cache is available.
 *
 * Either way the data enters through synthesised Challonge payloads and the
 * real `syncTournament`, so identity matching and the review queue behave as
 * they will in production.
 */

interface CacheRow {
  Date: string;
  Tournament: string;
  'Player 1': string;
  'Player 2': string;
  Winner: number | string;
}

export interface SeedResult {
  source: 'cache' | 'synthetic';
  tournaments: number;
  sets: number;
  players: number;
  queuedForReview: number;
}

/** Build Challonge-shaped fixtures from a real cache directory. */
function fixturesFromCache(cacheDir: string): { fixtures: FixtureTournament[]; registry: RegistryPlayerInput[] } {
  const pseudo = new Pseudonymiser();
  const files = readdirSync(cacheDir).filter((f) => f.endsWith('.json'));

  interface Event {
    slug: string;
    name: string;
    date: string;
    rows: CacheRow[];
  }
  const events: Event[] = [];
  for (const file of files) {
    const payload = JSON.parse(readFileSync(path.join(cacheDir, file), 'utf8')) as { rows?: CacheRow[] };
    const rows = payload.rows ?? [];
    // Skip the tiny unit-test fixtures that live in the same directory.
    if (rows.length < 5) continue;
    events.push({
      slug: file.replace(/\.json$/, ''),
      name: rows[0]!.Tournament,
      date: rows.reduce((min, r) => (r.Date < min ? r.Date : min), rows[0]!.Date),
      rows,
    });
  }
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.slug.localeCompare(b.slug)));

  // Pseudonymise by resolved identity so the same person keeps one alias
  // across events, and remember their company for the registry.
  const companyByPseudonym = new Map<string, string | null>();
  const identityToPseudonym = (raw: string): string => {
    const cleaned = cleanPlayerEntry(preparePlayerEntry(String(raw)));
    const alias = pseudo.get(`${cleaned.name.toLowerCase()}|${cleaned.companyCode ?? ''}`);
    if (!companyByPseudonym.has(alias)) companyByPseudonym.set(alias, cleaned.companyCode);
    return alias;
  };

  const fixtures: FixtureTournament[] = [];
  let participantIdSeed = 1000;
  let matchIdSeed = 500_000;

  events.forEach((event, eventIndex) => {
    const participantIds = new Map<string, number>();
    const nameFor = (raw: string): string => {
      const alias = identityToPseudonym(raw);
      const code = companyByPseudonym.get(alias);
      // Re-emit in the club's own "[CODE] Name" convention so the cleaning and
      // matching code paths get exercised the same way they will in production.
      return code ? `[${code}] ${alias}` : alias;
    };
    for (const row of event.rows) {
      for (const raw of [row['Player 1'], row['Player 2']]) {
        const display = nameFor(raw);
        if (!participantIds.has(display)) participantIds.set(display, ++participantIdSeed);
      }
    }

    const matches: FixtureMatchLocal[] = event.rows.map((row, index) => {
      const p1 = participantIds.get(nameFor(row['Player 1']))!;
      const p2 = participantIds.get(nameFor(row['Player 2']))!;
      const p1Won = Number(row.Winner) === 1;
      return {
        id: ++matchIdSeed,
        p1,
        p2,
        winner: p1Won ? p1 : p2,
        order: index + 1,
        round: Math.floor(index / 8) + 1,
        // Occasional forfeit, so the DQ-exclusion path has data.
        scores: index % 37 === 36 ? '-1-0' : p1Won ? '2-1' : '1-2',
      };
    });

    // The most recent event is left underway so live mode has something to show.
    const isLatest = eventIndex === events.length - 1;
    fixtures.push({
      slug: event.slug,
      id: 90_000 + eventIndex,
      name: event.name,
      state: isLatest ? 'underway' : 'complete',
      startedAt: `${event.date}T18:00:00.000+11:00`,
      completedAt: isLatest ? null : `${event.date}T21:30:00.000+11:00`,
      participants: [...participantIds.entries()].map(([name, id], index) => ({
        id,
        name,
        seed: index + 1,
        finalRank: isLatest ? null : ((index % 8) + 1),
      })),
      matches: isLatest ? matches.slice(0, Math.max(1, Math.floor(matches.length * 0.6))) : matches,
    });
  });

  // Registry covers most but deliberately not all players, so the review queue
  // is non-empty — that is the state an admin actually meets after a first sync.
  const allPseudonyms = [...companyByPseudonym.entries()];
  const registry: RegistryPlayerInput[] = allPseudonyms
    .filter((_, index) => index % 7 !== 6)
    .map(([alias, code], index) => ({
      id: `dev-${characterSlug(alias)}`,
      canonical_name: alias,
      company: code,
      aliases: [],
      main_character: index % 3 === 0 ? characterSlug(alias) : null,
    }));

  return { fixtures, registry };
}

interface FixtureMatchLocal {
  id: number;
  p1: number;
  p2: number;
  winner: number;
  order: number;
  round: number;
  scores: string;
}

/** How many club nights the synthetic club has run. */
const SYNTHETIC_EVENTS = 6;
/** Roughly a quarter between nights, so six of them span over two years. */
const SYNTHETIC_EVENT_GAP_DAYS = 100;
/** The most recent night is recent enough to still be underway. */
const SYNTHETIC_LATEST_DAYS_AGO = 24;

/**
 * Club nights, oldest first, dated relative to now rather than written down.
 *
 * Fixed dates rot: a fixture pinned to a calendar year quietly turns into "a
 * club that stopped meeting" as real time passes, and the rankings board hides
 * players who have not been seen in a year — so a pinned fixture eventually
 * seeds a board that renders empty by default. Anchoring to today keeps the
 * harness saying the same thing every day it is run.
 *
 * The span deliberately overshoots that one-year window, so the seeded club has
 * both a current field and a tail that has aged out of it.
 */
function syntheticEventDates(today: Date = new Date()): string[] {
  return Array.from({ length: SYNTHETIC_EVENTS }, (_, index) => {
    const daysAgo = SYNTHETIC_LATEST_DAYS_AGO + (SYNTHETIC_EVENTS - 1 - index) * SYNTHETIC_EVENT_GAP_DAYS;
    const date = new Date(today);
    date.setUTCDate(date.getUTCDate() - daysAgo);
    return date.toISOString().slice(0, 10);
  });
}

/** Deterministic synthetic club, used when no real cache is supplied. */
function syntheticFixtures(): { fixtures: FixtureTournament[]; registry: RegistryPlayerInput[] } {
  const pseudo = new Pseudonymiser();
  const roster = Array.from({ length: 48 }, (_, i) => pseudo.get(`synthetic-${i}`));
  // Fixed "true skill" so results are plausible rather than uniform noise.
  const skill = new Map(roster.map((name, i) => [name, 1200 + ((i * 37) % 600)]));
  const companies = ['ATL', 'CAN', 'GOOG', 'OPT', 'WOW'];
  /**
   * The people who came twice, early on, and never came back. Every club has
   * them, and the rankings board's activity setting exists for them — so the
   * harness has to seed some or the setting looks like it does nothing.
   */
  const lapsed = roster.slice(44);

  const fixtures: FixtureTournament[] = [];
  let matchId = 700_000;
  const dates = syntheticEventDates();

  dates.forEach((date, eventIndex) => {
    const isRookieEvent = eventIndex % 2 === 1;
    // Rookie brackets draw the lower half of the roster, with a little overlap.
    const pool = isRookieEvent ? roster.slice(24, 44) : roster.slice(0, 30);
    const entrants = [
      ...pool.filter((_, i) => (i + eventIndex) % 5 !== 4),
      ...(eventIndex < 2 ? lapsed : []),
    ];
    const participantIds = new Map<string, number>();
    entrants.forEach((name, i) => {
      participantIds.set(`[${companies[i % companies.length]!}] ${name}`, 2000 + eventIndex * 100 + i);
    });
    const keys = [...participantIds.keys()];

    const matches: FixtureMatchLocal[] = [];
    let order = 0;
    // Round-robin-ish pairing; deterministic outcome from the skill gap.
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j += 3) {
        const a = keys[i]!;
        const b = keys[j]!;
        const skillA = skill.get(a.replace(/^\[[A-Z]+\] /, ''))!;
        const skillB = skill.get(b.replace(/^\[[A-Z]+\] /, ''))!;
        // Favourite usually wins; a deterministic pattern supplies upsets.
        const upset = (i * 7 + j * 13 + eventIndex) % 9 === 0;
        const aWins = upset ? skillA < skillB : skillA >= skillB;
        matches.push({
          id: ++matchId,
          p1: participantIds.get(a)!,
          p2: participantIds.get(b)!,
          winner: participantIds.get(aWins ? a : b)!,
          order: ++order,
          round: Math.floor(order / 8) + 1,
          scores: aWins ? '2-1' : '1-2',
        });
      }
    }

    const isLatest = eventIndex === dates.length - 1;
    fixtures.push({
      slug: isRookieEvent ? `dev-weekly-${eventIndex}-rookies` : `dev-weekly-${eventIndex}`,
      id: 80_000 + eventIndex,
      name: isRookieEvent ? `Dev Weekly ${eventIndex} Rookies` : `Dev Weekly ${eventIndex}`,
      state: isLatest ? 'underway' : 'complete',
      startedAt: `${date}T18:00:00.000+11:00`,
      completedAt: isLatest ? null : `${date}T21:30:00.000+11:00`,
      participants: keys.map((name, i) => ({
        id: participantIds.get(name)!,
        name,
        seed: i + 1,
        finalRank: isLatest ? null : (i % 8) + 1,
      })),
      matches: isLatest ? matches.slice(0, Math.max(1, Math.floor(matches.length * 0.5))) : matches,
    });
  });

  const registry: RegistryPlayerInput[] = roster
    .filter((_, i) => i % 6 !== 5)
    .map((name, i) => ({
      id: `dev-${characterSlug(name)}`,
      canonical_name: name,
      company: companies[i % companies.length]!,
      aliases: [],
      main_character: i % 3 === 0 ? characterSlug(name) : null,
    }));

  return { fixtures, registry };
}

export async function seedDevData(db: Db, cacheDir?: string): Promise<{ result: SeedResult; client: ChallongeClient }> {
  const useCache = Boolean(cacheDir && existsSync(cacheDir));
  const { fixtures, registry } = useCache ? fixturesFromCache(cacheDir!) : syntheticFixtures();

  await importCompanyTaxonomy(db);
  await importRegistryPlayers(db, registry);

  const client = createFixtureClient(fixtures);
  let queuedForReview = 0;
  let sets = 0;

  for (const fixture of fixtures) {
    const [row] = await db
      .insert(tournaments)
      .values({
        challongeSlug: fixture.slug,
        name: fixture.name,
        isRookie: /rookie/i.test(fixture.name) || /rookie/i.test(fixture.slug),
      })
      .onConflictDoNothing()
      .returning({ id: tournaments.id });
    const tournamentId = row?.id ?? (await db.select({ id: tournaments.id }).from(tournaments).where(eq(tournaments.challongeSlug, fixture.slug)))[0]!.id;
    const result = await syncTournament(db, client, tournamentId);
    queuedForReview += result.queuedForReview;
    sets += result.setsUpserted;
  }

  await runRecompute(db);
  const playerCount = (await db.select({ id: players.id }).from(players)).length;

  return {
    result: {
      source: useCache ? 'cache' : 'synthetic',
      tournaments: fixtures.length,
      sets,
      players: playerCount,
      queuedForReview,
    },
    client,
  };
}
