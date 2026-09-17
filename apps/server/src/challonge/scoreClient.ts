/**
 * Narrow v2.1 score delivery adapter. Callers own authorisation, feature gating,
 * durable attempt records and reconciliation. This client never retries a PUT.
 * Verified contracts:
 * https://challonge.apidog.io/running-a-two-stage-tournament-1726921m0
 * https://challonge.apidog.io/get-match-23619746e0
 * https://challonge.apidog.io/authorization-1726705m0
 */
export class ChallongeScoreError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'identity_mismatch' | 'remote_conflict' | 'http_error' | 'unavailable' | 'invalid_response' | 'ambiguous',
    message: string,
    /** True means a write may have landed; reconcile with GET before any retry. */
    readonly mayHaveWritten = false,
    readonly status?: number,
  ) { super(message); this.name = 'ChallongeScoreError'; }
}
export interface ScoreParticipant {
  /** Root tournament participant ID, never a Nemesis player UUID. */
  participantId: string;
  /** Explicit, previously verified child IDs for group-stage participants. */
  aliases?: readonly string[];
  score: number;
}
export interface DeliverScoreInput {
  tournamentSlug: string;
  matchId: string;
  participants: readonly [ScoreParticipant, ScoreParticipant];
}
export interface RemoteScoreMatch {
  id: string;
  state: string;
  participantIds: readonly [string, string];
  winnerId: string | null;
  /** Null when there is no single score per participant (e.g. a multi-set payload). */
  scores: Readonly<Record<string, number>> | null;
}
const object = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
const id = (value: unknown): string | null =>
  (typeof value === 'string' || typeof value === 'number') && /^[1-9]\d*$/.test(String(value)) ? String(value) : null;

function parseMatch(payload: unknown, expectedId: string): RemoteScoreMatch {
  const resource = object(object(payload).data);
  const attributes = object(resource.attributes);
  const relationships = object(attributes.relationships ?? resource.relationships);
  const p1 = id(object(object(relationships.player1).data).id);
  const p2 = id(object(object(relationships.player2).data).id);
  if (id(resource.id) !== expectedId || !p1 || !p2 || p1 === p2 || typeof attributes.state !== 'string') {
    throw new ChallongeScoreError('invalid_response', 'Challonge did not return the expected match with two identified participants.');
  }
  let scores: Record<string, number> | null = null;
  if (Array.isArray(attributes.points_by_participant)) {
    const values = attributes.points_by_participant.map(point => object(point));
    if (values.length === 2 && new Set(values.map(point => id(point.participant_id))).size === 2 && values.every(point => {
      const key = id(point.participant_id);
      return key && [p1, p2].includes(key) && Array.isArray(point.scores) && point.scores.length === 1 &&
        typeof point.scores[0] === 'number' && Number.isInteger(point.scores[0]) && point.scores[0] >= 0;
    })) {
      scores = Object.fromEntries(values.map(point => [id(point.participant_id)!, (point.scores as number[])[0]!]));
    }
  }
  return { id: expectedId, state: attributes.state, participantIds: [p1, p2], winnerId: id(attributes.winner_id), scores };
}

export class ChallongeScoreClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly apiKey: string;
  constructor(options: { apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {
    if (!options.apiKey.trim()) throw new ChallongeScoreError('invalid_input', 'Challonge score delivery needs an API key.');
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new ChallongeScoreError('invalid_input', 'Timeout must be positive.');
  }

  private path(slug: string, matchId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(slug) || id(matchId) !== matchId) {
      throw new ChallongeScoreError('invalid_input', 'Supply a Challonge slug and numeric match ID.');
    }
    return `https://api.challonge.com/v2.1/tournaments/${encodeURIComponent(slug)}/matches/${matchId}.json`;
  }

  private async request(url: string, method: 'GET' | 'PUT', body?: unknown): Promise<unknown> {
    const writing = method === 'PUT';
    try {
      const response = await this.fetchImpl(url, {
        method, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { Authorization: this.apiKey, 'Authorization-Type': 'v1', Accept: 'application/json', 'Content-Type': 'application/vnd.api+json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        // Never include upstream bodies, URLs or transport errors: all may echo credentials.
        const ambiguous = writing && response.status >= 500;
        throw new ChallongeScoreError(ambiguous ? 'ambiguous' : 'http_error',
          response.status === 429 ? 'Challonge quota exhausted; no retry was attempted.' : `Challonge ${method} failed (HTTP ${response.status}).`, ambiguous, response.status);
      }
      // A PUT's body is not confirmation. Always verify with an independent GET.
      if (writing) { await response.body?.cancel(); return null; }
      return await response.json();
    } catch (error) {
      if (error instanceof ChallongeScoreError) throw error;
      throw new ChallongeScoreError(writing ? 'ambiguous' : 'unavailable',
        writing ? 'Score delivery outcome is unknown. Read the remote match before retrying.' : 'Could not read the Challonge match. No write was attempted.', writing);
    }
  }

  async readMatch(tournamentSlug: string, matchId: string): Promise<RemoteScoreMatch> {
    return parseMatch(await this.request(this.path(tournamentSlug, matchId), 'GET'), matchId);
  }

  async deliverScore(input: DeliverScoreInput): Promise<{ status: 'verified' | 'already_recorded'; match: RemoteScoreMatch }> {
    const participants = input.participants;
    if (participants.length !== 2 || participants.some(p => id(p.participantId) !== p.participantId ||
      !Number.isInteger(p.score) || p.score < 0 || p.score > 99 || p.aliases?.some(alias => id(alias) !== alias)) ||
      participants[0].score === participants[1].score) {
      throw new ChallongeScoreError('invalid_input', 'Delivery requires two identified participants and a decisive 0–99 score.');
    }
    const candidates = participants.map(p => new Set([p.participantId, ...(p.aliases ?? [])]));
    if ([...candidates[0]!].some(candidate => candidates[1]!.has(candidate))) {
      throw new ChallongeScoreError('identity_mismatch', 'Participant mappings overlap; reconcile group identities before delivery.');
    }
    const before = await this.readMatch(input.tournamentSlug, input.matchId);
    // Match by verified identities, never by current player-one/player-two order.
    const remoteIds = candidates.map(set => before.participantIds.filter(participantId => set.has(participantId)));
    if (remoteIds.some(matches => matches.length !== 1)) {
      throw new ChallongeScoreError('identity_mismatch', 'Remote participants differ from the recorded match. Re-import before delivering scores.');
    }
    const expectedScores = Object.fromEntries(remoteIds.map((matches, index) => [matches[0]!, participants[index]!.score]));
    const winnerId = remoteIds[participants[0].score > participants[1].score ? 0 : 1]![0]!;
    const matchesResult = (match: RemoteScoreMatch) => match.state === 'complete' && match.winnerId === winnerId &&
      match.participantIds.every(participantId => expectedScores[participantId] !== undefined && match.scores?.[participantId] === expectedScores[participantId]);
    if (matchesResult(before)) return { status: 'already_recorded', match: before };
    if (before.state === 'complete' || before.winnerId !== null || !['open', 'underway'].includes(before.state)) {
      throw new ChallongeScoreError('remote_conflict', 'Remote match is completed, blocked, or already has a result. Reconcile it before delivery.');
    }
    await this.request(this.path(input.tournamentSlug, input.matchId), 'PUT', { data: { type: 'Match', attributes: {
      match: remoteIds.map((matches, index) => ({ participant_id: matches[0]!, score_set: String(participants[index]!.score), ...(matches[0] === winnerId ? { advancing: true } : {}) })),
    } } });
    try {
      const after = await this.readMatch(input.tournamentSlug, input.matchId);
      if (!matchesResult(after)) throw new Error('verification mismatch');
      return { status: 'verified', match: after };
    } catch {
      throw new ChallongeScoreError('ambiguous', 'Score was submitted but could not be verified. Reconcile the remote match before retrying.', true);
    }
  }
}
