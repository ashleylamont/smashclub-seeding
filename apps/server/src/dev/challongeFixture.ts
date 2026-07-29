import { ChallongeClient } from '../challonge/client';

/**
 * A ChallongeClient backed by in-memory payloads shaped exactly like the v1
 * API's wrapped responses. Used by the dev harness (and mirrored in tests) so
 * seeding runs through the real sync pipeline — identity resolution, review
 * queue and all — rather than inserting rows behind its back.
 */

export interface FixtureParticipant {
  id: number;
  name: string;
  seed?: number;
  finalRank?: number | null;
}

export interface FixtureMatch {
  id: number;
  p1: number | null;
  p2: number | null;
  winner: number | null;
  state?: string;
  scores?: string | null;
  round?: number;
  order?: number;
  completedAt?: string | null;
}

export interface FixtureTournament {
  slug: string;
  id: number;
  name: string;
  state: 'pending' | 'underway' | 'complete';
  startedAt: string;
  completedAt?: string | null;
  participants: FixtureParticipant[];
  matches: FixtureMatch[];
}

function payloadsFor(fixture: FixtureTournament) {
  return {
    tournament: {
      tournament: {
        id: fixture.id,
        name: fixture.name,
        url: fixture.slug,
        state: fixture.state,
        started_at: fixture.startedAt,
        completed_at: fixture.completedAt ?? (fixture.state === 'complete' ? fixture.startedAt : null),
        updated_at: fixture.startedAt,
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
        completed_at: m.completedAt ?? fixture.startedAt,
        updated_at: fixture.startedAt,
      },
    })),
  };
}

export function createFixtureClient(fixtures: FixtureTournament[]): ChallongeClient {
  const bySlug = new Map(fixtures.map((f) => [f.slug, f]));
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    const match = url.match(/\/tournaments\/([^/]+?)(?:\/(participants|matches))?\.json$/);
    if (!match) return new Response('not found', { status: 404 });
    const fixture = bySlug.get(match[1]!);
    if (!fixture) return new Response('not found', { status: 404 });
    const payloads = payloadsFor(fixture);
    const body =
      match[2] === 'participants'
        ? payloads.participants
        : match[2] === 'matches'
          ? payloads.matches
          : payloads.tournament;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return new ChallongeClient({
    apiKey: 'dev',
    username: 'dev',
    minRequestSpacingMs: 0,
    fetchImpl,
  });
}
