import { ChallongeClient } from '../../src/challonge/client';

/**
 * Builders for Challonge v1 API payload shapes (mirroring the real wrapped
 * formats: {tournament: {...}}, [{participant: {...}}], [{match: {...}}]).
 */

export interface FixtureMatch {
  id: number;
  p1: number | null;
  p2: number | null;
  winner: number | null;
  state?: string;
  scores?: string | null;
  round?: number;
  order?: number;
  completedAt?: string;
}

export interface FixtureTournament {
  slug: string;
  id?: number;
  name?: string;
  state?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  participants: Array<{ id: number; name: string; seed?: number; finalRank?: number | null }>;
  matches: FixtureMatch[];
}

/**
 * When a match carries no explicit time, put it on its own tournament's day
 * rather than a shared hardcoded date.
 *
 * This matters beyond tidiness: the module payload (the default sync source)
 * has NO tournament-level timestamps, so the event date is derived from match
 * times. A fixture whose matches all share one timestamp would collapse every
 * club night onto the same date and quietly disable the per-day decay rule.
 * Real brackets carry per-match `underway_at`, so this mirrors reality.
 */
function defaultMatchTime(fixture: FixtureTournament): string {
  return fixture.completedAt ?? fixture.startedAt ?? '2025-01-10T20:00:00.000+11:00';
}

export function apiPayloads(fixture: FixtureTournament): {
  tournament: unknown;
  participants: unknown;
  matches: unknown;
} {
  return {
    tournament: {
      tournament: {
        id: fixture.id ?? 1000,
        name: fixture.name ?? fixture.slug,
        url: fixture.slug,
        state: fixture.state ?? 'complete',
        started_at: fixture.startedAt ?? '2025-01-10T18:00:00.000+11:00',
        completed_at: fixture.completedAt ?? (fixture.state === 'underway' ? null : '2025-01-10T21:00:00.000+11:00'),
        updated_at: '2025-01-10T21:05:00.000+11:00',
        tournament_type: 'double elimination',
      },
    },
    participants: fixture.participants.map((p) => ({
      participant: {
        id: p.id,
        display_name: p.name,
        name: p.name,
        seed: p.seed ?? null,
        final_rank: p.finalRank ?? null,
      },
    })),
    matches: fixture.matches.map((m) => ({
      match: {
        id: m.id,
        state: m.state ?? 'complete',
        round: m.round ?? 1,
        suggested_play_order: m.order ?? m.id,
        identifier: `M${m.id}`,
        player1_id: m.p1,
        player2_id: m.p2,
        winner_id: m.winner,
        scores_csv: m.scores === undefined ? '2-1' : m.scores,
        completed_at: m.completedAt ?? defaultMatchTime(fixture),
        updated_at: m.completedAt ?? defaultMatchTime(fixture),
      },
    })),
  };
}

/**
 * A ChallongeClient whose fetch is served from fixtures, keyed by slug.
 * Payloads are built per request so tests may mutate fixtures (e.g. seed
 * pushes) and see the change on re-fetch.
 */
/**
 * The `challonge.com/{slug}/module` page, which is what sync reads BY DEFAULT
 * (the API is opt-in — the free tier is 500 requests/month). The bracket is
 * embedded as `window._initialStoreState['TournamentStore']`, and the
 * tournament's name appears only in the page title.
 *
 * Note what this payload deliberately lacks, mirroring the real one: no
 * `final_rank`, no tournament-level timestamps, and no `suggested_play_order`
 * — the play order has to be recovered from the numeric `identifier`. This
 * fixture used to send `identifier` as a string, which is the v1 API's shape,
 * not this one; that hid the extractor dropping both fields on every real sync.
 */
function modulePage(fixture: FixtureTournament): string {
  const participantById = new Map(fixture.participants.map((p) => [p.id, p]));
  const player = (id: number | null | undefined) => {
    if (id === null || id === undefined) return null;
    const p = participantById.get(id);
    return p ? { id: p.id, display_name: p.name, seed: p.seed ?? null } : null;
  };
  const matchesByRound: Record<string, unknown[]> = {};
  for (const m of fixture.matches) {
    const round = String(m.round ?? 1);
    (matchesByRound[round] ??= []).push({
      id: m.id,
      round: m.round ?? 1,
      state: m.state ?? 'complete',
      // Mirrors the real module payload: a numeric play-order `identifier`, the
      // label under `raw_identifier`, and no `suggested_play_order` at all.
      identifier: m.order ?? m.id,
      raw_identifier: `M${m.id}`,
      winner_id: m.winner ?? null,
      // Real module payloads report `scores` as an array; `scores_csv` is also
      // accepted by the extractor and keeps these fixtures readable.
      scores_csv: m.scores === undefined ? '2-1' : m.scores,
      underway_at: m.completedAt ?? defaultMatchTime(fixture),
      player1: player(m.p1),
      player2: player(m.p2),
    });
  }
  const store = {
    requested_plotter: 'DoubleEliminationBracketPlotter',
    tournament: {
      id: 4242,
      state: fixture.state ?? 'complete',
      tournament_type: 'double elimination',
    },
    matches_by_round: matchesByRound,
  };
  return [
    `<!DOCTYPE html><html><head><title>${fixture.name ?? fixture.slug} - Challonge</title></head><body>`,
    '<script>',
    `window._initialStoreState = {}; window._initialStoreState['TournamentStore'] = ${JSON.stringify(store)};`,
    '</script></body></html>',
  ].join('\n');
}

export function fixtureClient(fixtures: FixtureTournament[]): ChallongeClient {
  const bySlug = new Map(fixtures.map((f) => [f.slug, f]));
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);

    const moduleMatch = url.match(/challonge\.com\/([^/]+)\/module$/);
    if (moduleMatch) {
      const fixture = bySlug.get(moduleMatch[1]!);
      if (!fixture) return new Response('not found', { status: 404 });
      return new Response(modulePage(fixture), {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    }

    const match = url.match(/\/tournaments\/([^/]+?)(?:\/(participants|matches))?\.json$/);
    if (!match) return new Response('not found', { status: 404 });
    const fixture = bySlug.get(match[1]!);
    if (!fixture) return new Response('not found', { status: 404 });
    const payloads = apiPayloads(fixture);
    const body =
      match[2] === 'participants' ? payloads.participants : match[2] === 'matches' ? payloads.matches : payloads.tournament;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return new ChallongeClient({
    apiKey: 'test-key',
    username: 'test-user',
    minRequestSpacingMs: 0,
    fetchImpl,
  });
}
