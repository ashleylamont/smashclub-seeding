import { describe, expect, it } from 'vitest';
import { ChallongeClient } from '../src/challonge/client';

const MODULE_HTML =
  '<title>Example - Challonge</title>' +
  '<script>window._initialStoreState[\'TournamentStore\'] = {"tournament":{"id":7,"state":"complete"},"matches_by_round":{}};</script>';

describe('ChallongeClient public bracket requests', () => {
  /**
   * Regression guard. The client sends `Accept: application/json` for the API,
   * but /module is an HTML page — asking Rails for a JSON representation it does
   * not have returns 500. It fails INTERMITTENTLY because Cloudflare serves
   * cached HTML for some requests regardless of Accept, so the same URL
   * alternates 200/500 and looks slug-specific. Measured before the fix: ~10 of
   * 20 requests failed with application/json, 0 of 12 with text/html.
   */
  it('requests the module page as HTML, not JSON', async () => {
    let headers: Record<string, string> | undefined;
    const client = new ChallongeClient({
      minRequestSpacingMs: 0,
      fetchImpl: async (_input, init) => {
        headers = init?.headers as Record<string, string>;
        return new Response(MODULE_HTML, { status: 200 });
      },
    });

    await client.fetchPublicBracket('example');
    expect(headers?.Accept).toBe('text/html');
  });

  it('hits the /module endpoint on the public host', async () => {
    let url = '';
    const client = new ChallongeClient({
      minRequestSpacingMs: 0,
      fetchImpl: async (input) => {
        url = String(input);
        return new Response(MODULE_HTML, { status: 200 });
      },
    });

    await client.fetchPublicBracket('example');
    expect(url).toBe('https://challonge.com/example/module');
  });

  it('does not retry a 429 — the quota is monthly, not a burst limit', async () => {
    let calls = 0;
    const client = new ChallongeClient({
      apiKey: 'k',
      username: 'u',
      minRequestSpacingMs: 0,
      fetchImpl: async () => {
        calls += 1;
        return new Response('{}', { status: 429 });
      },
    });

    await expect(client.fetchTournamentBundle('example')).rejects.toThrow(/quota is exhausted/i);
    expect(calls).toBe(1);
  });
});
