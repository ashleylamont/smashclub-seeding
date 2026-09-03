import { describe, expect, it } from 'vitest';
import {
  ChallongePayloadError,
  extractModuleBracketPayload,
  extractModuleTournamentName,
  extractPublicBracket,
} from '../src/challonge/extract';

/**
 * The public fallback reads `https://challonge.com/{slug}/module` because
 * `{slug}.json` is now behind Cloudflare's bot challenge. These fixtures are
 * SYNTHETIC — same structure as the live page, invented names — because this
 * repository is public and the real brackets carry club members' names.
 */

/** A cut-down `/module` page: the payload sits among other store assignments. */
function modulePage(tournamentStore: string): string {
  return [
    '<!DOCTYPE html><html><head><title>Bracket</title></head><body>',
    '<script>',
    "window._initialStoreState = {}; window._initialStoreState['CurrentUserStore'] = {\"locale\":\"en\"};",
    `window._initialStoreState['TournamentStore'] = ${tournamentStore};`,
    "window._initialStoreState['AfterStore'] = {\"trailing\":true};",
    '</script></body></html>',
  ].join('\n');
}

const STORE = JSON.stringify({
  requested_plotter: 'DoubleEliminationBracketPlotter',
  tournament: { id: 111, state: 'complete' },
  matches_by_round: {
    '1': [
      {
        id: 9001,
        round: 1,
        state: 'complete',
        // The real module payload numbers `identifier` and puts the label in
        // `raw_identifier` — the opposite way round from the v1 API.
        identifier: 1,
        raw_identifier: 'A',
        winner_id: 5001,
        loser_id: 5002,
        scores: [2, 1],
        underway_at: '2025-08-14T17:46:04.675+10:00',
        player1: { id: 5001, display_name: 'Alpha { brace } "quote"', seed: 1 },
        player2: { id: 5002, display_name: 'Bravo', seed: 2 },
      },
    ],
    '2': [
      {
        id: 9002,
        round: 2,
        state: 'complete',
        identifier: 2,
        raw_identifier: 'B',
        winner_id: 5003,
        loser_id: 5001,
        scores: [2, -1],
        underway_at: '2025-08-14T18:21:50.655+10:00',
        player1: { id: 5003, display_name: 'Charlie', seed: 3 },
        player2: { id: 5001, display_name: 'Alpha { brace } "quote"', seed: 1 },
      },
    ],
  },
});

describe('extractModuleBracketPayload', () => {
  it('pulls the TournamentStore payload out of the module page', () => {
    const payload = extractModuleBracketPayload(modulePage(STORE)) as Record<string, unknown>;
    expect(payload.requested_plotter).toBe('DoubleEliminationBracketPlotter');
    expect(Object.keys(payload.matches_by_round as object)).toEqual(['1', '2']);
  });

  it('stops at the right brace when names contain braces or escaped quotes', () => {
    const payload = extractModuleBracketPayload(modulePage(STORE)) as Record<string, unknown>;
    const round1 = (payload.matches_by_round as Record<string, Record<string, unknown>[]>)['1']!;
    const player1 = round1[0]!.player1 as Record<string, unknown>;
    // A naive scan to the first `}` would truncate here.
    expect(player1.display_name).toBe('Alpha { brace } "quote"');
  });

  it('throws a clear error when the page is a Cloudflare challenge instead of a bracket', () => {
    const challenge =
      '<!DOCTYPE html><html><head><title>Just a moment...</title></head>' +
      '<body>Enable JavaScript and cookies to continue</body></html>';
    expect(() => extractModuleBracketPayload(challenge)).toThrow(ChallongePayloadError);
    expect(() => extractModuleBracketPayload(challenge)).toThrow(/embedded TournamentStore/i);
  });

  it('rejects a truncated payload rather than returning a partial bracket', () => {
    const truncated = "<script>window._initialStoreState['TournamentStore'] = {\"matches_by_round\":{";
    expect(() => extractModuleBracketPayload(truncated)).toThrow(/truncated/i);
  });
});

describe('extractModuleTournamentName', () => {
  it('recovers the tournament name from the page title', () => {
    // The module payload has no name field; the title is the only source.
    expect(extractModuleTournamentName('<title>\nTech In Place # 10 - \nChallonge\n</title>')).toBe(
      'Tech In Place # 10',
    );
  });

  it('returns null when there is no title, so callers keep the name they hold', () => {
    // Returning the slug here would rename every tournament to its slug.
    expect(extractModuleTournamentName('<html><body>no title</body></html>')).toBeNull();
    expect(extractModuleTournamentName('<title> - Challonge</title>')).toBeNull();
  });
});

describe('extractPublicBracket over a module payload', () => {
  it('orders each stage by play order and preserves final seeds over pool-local seeds', () => {
    const first = { id: 5001, display_name: 'Alpha', seed: 8 };
    const second = { id: 5002, display_name: 'Bravo', seed: 7 };
    const match = (id: number, identifier: number) => ({
      id, identifier, state: 'complete', winner_id: 5001, player1: first, player2: second,
    });
    const bracket = extractPublicBracket({
      matches_by_round: { '1': [match(20, 2), match(10, 1)] },
      groups: [{
        tournament: { id: 70 },
        matches_by_round: { '1': [
          { ...match(40, 2), player1: { ...first, id: 101, participant_id: 5001, seed: 1 } },
          { ...match(30, 1), player2: { id: 103, participant_id: 5003, display_name: 'Charlie', seed: 2 } },
        ] },
      }],
    });
    expect(bracket.matches.map((m) => [m.id, m.suggestedPlayOrder])).toEqual([[30, 1], [40, 2], [10, 3], [20, 4]]);
    expect(bracket.participants.find((p) => p.id === 5001)?.seed).toBe(8);
    expect(bracket.participants.find((p) => p.id === 5003)?.seed).toBeNull();
  });

  it('flattens nested group stages and normalises their root participant IDs', () => {
    const store = JSON.parse(STORE) as Record<string, any>;
    store.groups = [
      {
        tournament: { id: 222 },
        matches_by_round: {
          '1': [{
            id: 9010,
            identifier: 1,
            raw_identifier: 'A',
            round: 1,
            state: 'complete',
            underway_at: '2025-08-14T16:00:00.000+10:00',
            scores: [2, 0],
            winner_id: 6001,
            player1: { id: 6001, participant_id: 5001, display_name: 'Alpha { brace } "quote"', seed: 1 },
            player2: { id: 6002, participant_id: 5002, display_name: 'Bravo', seed: 2 },
          }],
        },
      },
    ];
    const bracket = extractPublicBracket(extractModuleBracketPayload(modulePage(JSON.stringify(store))));
    expect(bracket.matches).toHaveLength(3);
    expect(bracket.matches[0]).toMatchObject({ id: 9010, stage: 'group', groupId: 222, player1Id: 5001, player2Id: 5002, winnerId: 5001 });
    expect(bracket.matches[1]!.stage).toBe('final');
    expect(bracket.participants.map((p) => p.id).sort()).toEqual([5001, 5002, 5003]);
  });

  it('reads participants and matches from the embedded structure', () => {
    const bracket = extractPublicBracket(extractModuleBracketPayload(modulePage(STORE)));
    expect(bracket.matches).toHaveLength(2);
    expect(bracket.allComplete).toBe(true);
    expect(bracket.latestMatchDate).toBe('2025-08-14T18:21:50.655+10:00');
    expect(bracket.participants.map((p) => p.id).sort()).toEqual([5001, 5002, 5003]);
    expect(bracket.participants.find((p) => p.id === 5003)?.seed).toBe(3);
  });

  it('normalises the `scores` array into scores_csv so forfeits stay detectable', () => {
    const bracket = extractPublicBracket(extractModuleBracketPayload(modulePage(STORE)));
    // The module payload has no scores_csv; without this mapping every set
    // would look like a clean win and forfeits would enter the ratings.
    expect(bracket.matches.find((m) => m.id === 9001)?.scoresCsv).toBe('2-1');
    expect(bracket.matches.find((m) => m.id === 9002)?.scoresCsv).toBe('2--1');
  });

  it('does not turn a missing winner into player one', () => {
    const store = JSON.parse(STORE) as Record<string, any>;
    delete store.matches_by_round['1'][0].winner_id;
    const bracket = extractPublicBracket(extractModuleBracketPayload(modulePage(JSON.stringify(store))));
    expect(bracket.matches[0]!.winnerId).toBeNull();
  });

  it('rejects conflicting duplicate match IDs across stages', () => {
    const store = JSON.parse(STORE) as Record<string, any>;
    store.groups = [{ tournament: { id: 222 }, matches_by_round: { '1': [{
      ...store.matches_by_round['1'][0], id: 9001, winner_id: 5002,
      player1: { id: 5001, participant_id: 5001, display_name: 'Alpha' },
      player2: { id: 5002, participant_id: 5002, display_name: 'Bravo' },
    }] } }];
    expect(() => extractPublicBracket(extractModuleBracketPayload(modulePage(JSON.stringify(store))))).toThrow(/conflicting entries/i);
  });

  it('still prefers scores_csv when the payload provides it', () => {
    const store = JSON.parse(STORE) as Record<string, never>;
    const withCsv = JSON.parse(JSON.stringify(store)) as {
      matches_by_round: Record<string, Record<string, unknown>[]>;
    };
    withCsv.matches_by_round['1']![0]!.scores_csv = '3-0';
    const bracket = extractPublicBracket(extractModuleBracketPayload(modulePage(JSON.stringify(withCsv))));
    expect(bracket.matches.find((m) => m.id === 9001)?.scoresCsv).toBe('3-0');
  });
});
