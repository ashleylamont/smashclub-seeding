import {
  extractMatches,
  extractModuleBracketPayload,
  extractParticipants,
  extractPublicBracket,
  extractTournament,
  type ChallongeMatch,
  type ChallongeParticipant,
  type ChallongeTournament,
  type PublicBracket,
} from '@smashclub/engine';

export class ChallongeApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface ChallongeClientOptions {
  apiKey?: string;
  username?: string;
  /** Minimum spacing between requests (Challonge v1 limits are undocumented). */
  minRequestSpacingMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  publicBaseUrl?: string;
}

export interface TournamentBundle {
  tournament: ChallongeTournament;
  participants: ChallongeParticipant[];
  matches: ChallongeMatch[];
  source: 'api' | 'public';
}

/**
 * Challonge v1 client. All requests flow through a single queue with minimum
 * spacing and exponential backoff on 429/5xx. Falls back to the public
 * bracket JSON for reads when credentials are missing or the API 404s.
 */
export class ChallongeClient {
  private readonly apiKey?: string;
  private readonly username?: string;
  private readonly spacingMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly publicBaseUrl: string;
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(options: ChallongeClientOptions = {}) {
    this.apiKey = options.apiKey;
    this.username = options.username;
    this.spacingMs = options.minRequestSpacingMs ?? 500;
    this.maxRetries = options.maxRetries ?? 3;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? 'https://api.challonge.com/v1';
    this.publicBaseUrl = options.publicBaseUrl ?? 'https://challonge.com';
  }

  get hasCredentials(): boolean {
    return Boolean(this.apiKey && this.username);
  }

  async fetchTournamentBundle(slug: string): Promise<TournamentBundle> {
    if (this.hasCredentials) {
      try {
        const tournament = extractTournament(await this.requestJson(`${this.baseUrl}/tournaments/${slug}.json`, true));
        const participants = extractParticipants(
          await this.requestJson(`${this.baseUrl}/tournaments/${slug}/participants.json`, true),
        );
        const matches = extractMatches(
          await this.requestJson(`${this.baseUrl}/tournaments/${slug}/matches.json`, true),
        );
        return { tournament, participants, matches, source: 'api' };
      } catch (error) {
        if (!(error instanceof ChallongeApiError) || error.status !== 404) throw error;
        // 404 with credentials: tournament may be outside the account; try public.
      }
    }
    return this.fetchPublicTournamentBundle(slug);
  }

  /**
   * Bundle built purely from the public bracket, never touching the metered
   * API. This is what live polling uses: Challonge's free tier allows 500 API
   * requests per MONTH, so a metered poll loop is not viable at any interval.
   *
   * `state` is deliberately NOT reported as `underway` for an unfinished
   * bracket. The public payload cannot distinguish "in progress right now"
   * from "abandoned in 2022", and treating unfinished as underway is what made
   * dead tournaments poll forever. Anything not complete is reported as
   * `unknown`; liveness is an explicit, expiring admin decision instead.
   */
  async fetchPublicTournamentBundle(slug: string): Promise<TournamentBundle> {
    const bracket = await this.fetchPublicBracket(slug);
    const tournament: ChallongeTournament = {
      id: 0,
      name: slug,
      url: slug,
      state: bracket.allComplete ? 'complete' : 'unknown',
      startedAt: null,
      completedAt: bracket.allComplete ? bracket.latestMatchDate : null,
      updatedAt: bracket.latestMatchDate,
      tournamentType: null,
    };
    return { tournament, participants: bracket.participants, matches: bracket.matches, source: 'public' };
  }

  /**
   * Public fallback for tournaments outside the credentialed account — the API
   * 404s for those, and most of the club's history belongs to other organisers.
   *
   * Reads the embeddable `/module` page rather than `{slug}.json`: that JSON
   * endpoint now sits behind Cloudflare's bot challenge and answers any
   * non-browser client with 403 + `cf-mitigated: challenge`, whatever
   * User-Agent it sends. The module page is not challenged and embeds the same
   * `matches_by_round` payload.
   */
  async fetchPublicBracket(slug: string): Promise<PublicBracket> {
    const response = await this.request(`${this.publicBaseUrl}/${slug}/module`, false);
    return extractPublicBracket(extractModuleBracketPayload(await response.text()));
  }

  /** PUT participant seed; used by the seeding push. */
  async updateParticipantSeed(slug: string, participantId: number, seed: number): Promise<void> {
    if (!this.hasCredentials) {
      throw new ChallongeApiError('Challonge credentials are required to push seeds.');
    }
    await this.request(
      `${this.baseUrl}/tournaments/${slug}/participants/${participantId}.json`,
      true,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ participant: { seed } }),
      },
    );
  }

  private async requestJson(url: string, useAuth: boolean): Promise<unknown> {
    const response = await this.request(url, useAuth);
    try {
      return await response.json();
    } catch {
      throw new ChallongeApiError('Challonge API returned invalid JSON.');
    }
  }

  private request(url: string, useAuth: boolean, init: RequestInit = {}): Promise<Response> {
    const run = this.queue.then(() => this.requestWithRetries(url, useAuth, init));
    // Keep the queue alive regardless of individual failures.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async requestWithRetries(url: string, useAuth: boolean, init: RequestInit): Promise<Response> {
    let attempt = 0;
    for (;;) {
      await this.waitForSpacing();
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'User-Agent': 'smashclub/1.0 (+club ranking sync)',
        ...(init.headers as Record<string, string> | undefined),
      };
      if (useAuth && this.hasCredentials) {
        const token = Buffer.from(`${this.username}:${this.apiKey}`).toString('base64');
        headers.Authorization = `Basic ${token}`;
      }
      let response: Response;
      try {
        response = await this.fetchImpl(url, { ...init, headers });
      } catch (error) {
        if (attempt >= this.maxRetries) {
          throw new ChallongeApiError(`Failed to reach Challonge: ${String(error)}`);
        }
        await sleep(backoffMs(attempt));
        attempt += 1;
        continue;
      }
      // 429 is NOT retried. Challonge's limit is a MONTHLY request quota, not a
      // burst limit, so a 429 means the allowance is gone — retrying three
      // times with backoff turns one rejected request into four, all of which
      // still count against the quota. Fail loudly and immediately instead.
      if (response.status === 429) {
        throw new ChallongeApiError(
          `Challonge rejected the request (429): the API request quota is exhausted. ` +
            `The free tier allows 500 requests per month; check https://connect.challonge.com. ` +
            `This request was NOT retried, deliberately.`,
          429,
        );
      }
      if (response.status >= 500) {
        if (attempt >= this.maxRetries) {
          throw new ChallongeApiError(`Challonge request failed (${response.status}) after retries.`, response.status);
        }
        await sleep(backoffMs(attempt));
        attempt += 1;
        continue;
      }
      if (response.status === 401) {
        throw new ChallongeApiError(
          'Challonge API authentication failed (401). Check CHALLONGE_USERNAME and CHALLONGE_API_KEY.',
          401,
        );
      }
      if (response.status === 404) {
        throw new ChallongeApiError('Challonge tournament not found (404).', 404);
      }
      if (!response.ok) {
        // Report the headers that identify WHY, not 200 chars of body. A
        // Cloudflare challenge page's body says only "Just a moment..." while
        // `cf-mitigated: challenge` is what distinguishes bot-blocking from an
        // auth or slug problem — the useful half used to be discarded.
        const mitigated = response.headers.get('cf-mitigated');
        const server = response.headers.get('server');
        const contentType = response.headers.get('content-type') ?? 'unknown';
        const hint = mitigated
          ? ` — blocked by a ${server ?? 'CDN'} bot challenge (cf-mitigated: ${mitigated}); this endpoint cannot be read by a non-browser client`
          : '';
        const detail = (await response.text().catch(() => '')).slice(0, 200);
        throw new ChallongeApiError(
          `Challonge request failed (${response.status}) for ${url} [content-type: ${contentType}]${hint}: ${detail}`,
          response.status,
        );
      }
      return response;
    }
  }

  private async waitForSpacing(): Promise<void> {
    const now = Date.now();
    const wait = this.lastRequestAt + this.spacingMs - now;
    this.lastRequestAt = Math.max(now, this.lastRequestAt + this.spacingMs);
    if (wait > 0) await sleep(wait);
  }
}

function backoffMs(attempt: number): number {
  return 1000 * 2 ** attempt;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
