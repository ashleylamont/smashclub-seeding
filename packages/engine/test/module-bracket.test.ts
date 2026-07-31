import { describe, expect, it } from 'vitest';
import { ChallongePayloadError, extractModuleBracketPayload, extractPublicBracket } from '../src/challonge/extract';

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
        identifier: 'A',
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
        identifier: 'B',
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

describe('extractPublicBracket over a module payload', () => {
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
