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
        completed_at: m.completedAt ?? '2025-01-10T20:00:00.000+11:00',
        updated_at: '2025-01-10T20:00:00.000+11:00',
      },
    })),
  };
}

/**
 * A ChallongeClient whose fetch is served from fixtures, keyed by slug.
 * Payloads are built per request so tests may mutate fixtures (e.g. seed
 * pushes) and see the change on re-fetch.
 */
export function fixtureClient(fixtures: FixtureTournament[]): ChallongeClient {
  const bySlug = new Map(fixtures.map((f) => [f.slug, f]));
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
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
