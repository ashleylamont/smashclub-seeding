/**
 * Pure parsing of Challonge v1 API payloads into typed structures. No HTTP —
 * the server's client fetches JSON and hands it here, which keeps everything
 * testable against recorded payload fixtures.
 */

export class ChallongePayloadError extends Error {}

export interface ChallongeTournament {
  id: number;
  name: string;
  url: string;
  state: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
  tournamentType: string | null;
}

export interface ChallongeParticipant {
  id: number;
  displayName: string;
  seed: number | null;
  finalRank: number | null;
}

export interface ChallongeMatch {
  id: number;
  state: string;
  round: number | null;
  suggestedPlayOrder: number | null;
  identifier: string | null;
  player1Id: number | null;
  player2Id: number | null;
  winnerId: number | null;
  scoresCsv: string | null;
  completedAt: string | null;
  updatedAt: string | null;
}

function asRecord(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ChallongePayloadError(`Unexpected ${description} format from Challonge API.`);
  }
  return value as Record<string, unknown>;
}

function unwrap(value: unknown, key: string, description: string): Record<string, unknown> {
  const record = asRecord(value, description);
  return asRecord(record[key], description);
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** `GET /tournaments/{id}.json` → typed tournament. */
export function extractTournament(payload: unknown): ChallongeTournament {
  const t = unwrap(payload, 'tournament', 'tournament');
  const id = num(t.id);
  if (id === null) throw new ChallongePayloadError('Challonge tournament payload missing numeric id.');
  return {
    id,
    name: (str(t.name) ?? str(t.url) ?? String(id)).trim(),
    url: str(t.url) ?? String(id),
    state: str(t.state) ?? 'unknown',
    startedAt: str(t.started_at),
    completedAt: str(t.completed_at),
    updatedAt: str(t.updated_at),
    tournamentType: str(t.tournament_type),
  };
}

/** `GET /tournaments/{id}/participants.json` → typed participants. */
export function extractParticipants(payload: unknown): ChallongeParticipant[] {
  if (!Array.isArray(payload)) {
    throw new ChallongePayloadError('Unexpected participants format from Challonge API.');
  }
  const participants: ChallongeParticipant[] = [];
  for (const item of payload) {
    const p = unwrap(item, 'participant', 'participant');
    const id = num(p.id);
    const displayName = (str(p.display_name) ?? str(p.name) ?? '').trim();
    if (id === null || !displayName) continue;
    participants.push({
      id,
      displayName,
      seed: num(p.seed),
      finalRank: num(p.final_rank),
    });
  }
  return participants;
}

/** `GET /tournaments/{id}/matches.json` → typed matches (all states). */
export function extractMatches(payload: unknown): ChallongeMatch[] {
  if (!Array.isArray(payload)) {
    throw new ChallongePayloadError('Unexpected matches format from Challonge API.');
  }
  return payload.map((item) => {
    const m = unwrap(item, 'match', 'match');
    const id = num(m.id);
    if (id === null) throw new ChallongePayloadError('Challonge match payload missing numeric id.');
    return {
      id,
      state: str(m.state) ?? 'unknown',
      round: num(m.round),
      suggestedPlayOrder: num(m.suggested_play_order),
      identifier: str(m.identifier),
      player1Id: num(m.player1_id),
      player2Id: num(m.player2_id),
      winnerId: num(m.winner_id),
      scoresCsv: str(m.scores_csv),
      completedAt: str(m.completed_at),
      updatedAt: str(m.updated_at),
    };
  });
}

/**
 * A match is rateable when complete with both players and a winner that is
 * one of them (skips byes, DQ-ed pairings with a missing side, and pending
 * matches — legacy import semantics).
 */
export function isRateableMatch(match: ChallongeMatch): boolean {
  return (
    match.state === 'complete' &&
    match.player1Id !== null &&
    match.player2Id !== null &&
    match.winnerId !== null &&
    (match.winnerId === match.player1Id || match.winnerId === match.player2Id)
  );
}

/**
 * Challonge marks forfeits/DQs with a negative game score (e.g. "-1-0").
 * Such sets are excluded from ratings by default (admin-overridable).
 */
export function scoresIndicateForfeit(scoresCsv: string | null): boolean {
  if (!scoresCsv) return false;
  return scoresCsv.split(',').some((setScore) => {
    const match = setScore.trim().match(/^(-?\d+)-(-?\d+)$/);
    if (!match) return false;
    return Number(match[1]) < 0 || Number(match[2]) < 0;
  });
}

export interface PublicBracket {
  participants: ChallongeParticipant[];
  matches: ChallongeMatch[];
  /** True when every listed match is complete. */
  allComplete: boolean;
  /** Latest underway_at across completed matches, if any. */
  latestMatchDate: string | null;
}

/**
 * Pulls the bracket payload out of the `https://challonge.com/{slug}/module`
 * page, which embeds it as `window._initialStoreState['TournamentStore']`.
 *
 * WHY SCRAPE A PAGE INSTEAD OF READING JSON: `https://challonge.com/{slug}.json`
 * — the endpoint this fallback used to call — is now behind Cloudflare's bot
 * challenge and answers non-browser clients with `403` +
 * `cf-mitigated: challenge`, regardless of User-Agent. The `/module` page (the
 * embeddable bracket) is not challenged and carries the same
 * `matches_by_round` structure the JSON endpoint returned, so
 * {@link extractPublicBracket} consumes it unchanged.
 *
 * This is an undocumented internal shape and can change without notice. It is
 * only reachable for tournaments outside the credentialed account; anything the
 * API can see is fetched through the API instead.
 */
export function extractModuleBracketPayload(html: string): unknown {
  const marker = /window\._initialStoreState\[['"]TournamentStore['"]\]\s*=\s*/.exec(html);
  if (!marker) {
    throw new ChallongePayloadError(
      'Challonge bracket page did not contain an embedded TournamentStore payload.',
    );
  }
  const start = html.indexOf('{', marker.index + marker[0].length);
  if (start === -1) {
    throw new ChallongePayloadError('Challonge TournamentStore assignment was not an object.');
  }
  // Brace-match past strings so braces inside player names/URLs do not end it early.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i += 1) {
    const ch = html[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const raw = html.slice(start, i + 1);
        try {
          return JSON.parse(raw);
        } catch (error) {
          throw new ChallongePayloadError(
            `Challonge TournamentStore payload was not valid JSON: ${String(error)}`,
          );
        }
      }
    }
  }
  throw new ChallongePayloadError('Challonge TournamentStore payload was truncated.');
}

/**
 * The module payload carries the tournament's id, state and type but NOT its
 * name — that appears only in the page title, as "<name> - Challonge".
 *
 * Returns null when no name can be recovered, so callers keep the name they
 * already hold rather than overwriting it with a slug.
 */
export function extractModuleTournamentName(html: string): string | null {
  const match = /<title>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return null;
  const title = match[1]!.replace(/\s+/g, ' ').trim();
  const name = title.replace(/\s*-\s*Challonge\s*$/i, '').trim();
  return name.length > 0 ? name : null;
}

/**
 * Challonge's JSON endpoint reports set scores as `scores_csv` ("2-1,0-2"); the
 * embedded module payload reports them as a `scores` array ([2, 1]). Normalise
 * the latter so forfeit detection keeps working — {@link scoresIndicateForfeit}
 * looks for a negative game score, and dropping this would silently stop
 * excluding forfeited sets from ratings.
 */
function scoresCsvFrom(value: unknown): string | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [a, b] = value;
  if (typeof a !== 'number' || typeof b !== 'number') return null;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return `${a}-${b}`;
}

/**
 * The unauthenticated fallback payload: matches grouped by round with embedded
 * player objects. Participants are derived from the embedded players (the
 * public payload has no participant list). Accepts both the historical
 * `{slug}.json` shape and the `{slug}/module` TournamentStore shape — they
 * agree on `matches_by_round`.
 */
export function extractPublicBracket(payload: unknown): PublicBracket {
  const record = asRecord(payload, 'public bracket');
  const byRound = record.matches_by_round;
  if (typeof byRound !== 'object' || byRound === null || Array.isArray(byRound)) {
    throw new ChallongePayloadError('Public Challonge bracket JSON did not include matches_by_round data.');
  }

  const rawMatches: Record<string, unknown>[] = [];
  for (const roundMatches of Object.values(byRound as Record<string, unknown>)) {
    if (Array.isArray(roundMatches)) {
      for (const m of roundMatches) {
        if (typeof m === 'object' && m !== null && !Array.isArray(m)) {
          rawMatches.push(m as Record<string, unknown>);
        }
      }
    }
  }

  const participantsById = new Map<number, ChallongeParticipant>();
  const matches: ChallongeMatch[] = [];
  const completedDates: string[] = [];
  for (const m of rawMatches) {
    const player1 = typeof m.player1 === 'object' && m.player1 !== null ? (m.player1 as Record<string, unknown>) : {};
    const player2 = typeof m.player2 === 'object' && m.player2 !== null ? (m.player2 as Record<string, unknown>) : {};
    for (const p of [player1, player2]) {
      const pid = num(p.id);
      const displayName = (str(p.display_name) ?? str(p.name) ?? '').trim();
      if (pid !== null && displayName && !participantsById.has(pid)) {
        participantsById.set(pid, { id: pid, displayName, seed: num(p.seed), finalRank: null });
      }
    }
    const id = num(m.id);
    if (id === null) continue;
    const state = str(m.state) ?? 'unknown';
    if (state === 'complete' && str(m.underway_at)) completedDates.push(str(m.underway_at)!);
    matches.push({
      id,
      state,
      round: num(m.round),
      suggestedPlayOrder: num(m.suggested_play_order),
      identifier: str(m.identifier),
      player1Id: num(player1.id),
      player2Id: num(player2.id),
      winnerId: num(m.winner_id),
      scoresCsv: str(m.scores_csv) ?? scoresCsvFrom(m.scores),
      completedAt: str(m.completed_at) ?? str(m.underway_at),
      updatedAt: str(m.updated_at),
    });
  }

  completedDates.sort();
  return {
    participants: [...participantsById.values()],
    matches,
    allComplete: matches.length > 0 && matches.every((m) => m.state === 'complete'),
    latestMatchDate: completedDates[completedDates.length - 1] ?? null,
  };
}

/** Accepts a bare slug or any challonge.com URL and returns the slug. */
export function normalizeTournamentId(tournamentId: string): string {
  const raw = tournamentId.trim();
  if (!raw) throw new ChallongePayloadError('Tournament ID cannot be empty.');
  if (!raw.includes('://')) return raw.replace(/^\/+|\/+$/g, '');
  const urlMatch = raw.match(/^[a-z]+:\/\/([^/?#]+)([^?#]*)/i);
  if (!urlMatch) {
    throw new ChallongePayloadError(`Could not extract a tournament ID from '${tournamentId}'.`);
  }
  const host = urlMatch[1]!.toLowerCase();
  const parts = (urlMatch[2] ?? '').split('/').filter(Boolean);
  if (parts.length === 0) {
    throw new ChallongePayloadError(`Could not extract a tournament ID from '${tournamentId}'.`);
  }
  if (parts[0] === 'tournaments' && parts.length > 1) return parts[1]!;
  // Subdomain-hosted tournaments (e.g. org.challonge.com/slug) need the
  // subdomain prefix for API lookups.
  const subdomainMatch = host.match(/^([^.]+)\.challonge\.com$/);
  if (subdomainMatch && subdomainMatch[1] !== 'www' && subdomainMatch[1] !== 'api') {
    return `${subdomainMatch[1]}-${parts[0]}`;
  }
  return parts[0]!;
}

/** Human-readable tournament name from a slug (legacy special-cases kept). */
export function humanizeTournamentSlug(slug: string): string {
  const special: Record<string, string> = {
    titlesponsorbattlegrounds: 'Title Sponsor Battlegrounds',
    titlesponsorrookierumble: 'Title Sponsor Rookie Rumble',
    framedatasignalschampionship: 'Frame Data Signals Championship',
    enterprisetransformationopen: 'Enterprise Transformation Open',
    fuelthefightwheel: 'Fuel the Fight Wheel',
    devoopsopen: 'DevOops Open',
    elevateyourgame: 'Elevate Your Game',
    teamkken24: 'Team KKEN 24',
    pavethepath: 'Pave the Path',
    devprodpunchout: 'DevProd Punch Out',
  };
  const lowered = slug.toLowerCase();
  if (lowered.startsWith('techinplace')) {
    const suffix = lowered.slice('techinplace'.length);
    const parts = suffix.match(/[a-zA-Z]+|\d+/g) ?? [];
    return ['Tech', 'In', 'Place', ...parts.map(capitalize)].join(' ').trim();
  }
  if (lowered in special) return special[lowered]!;
  let value = slug.replace(/([a-z])([A-Z])/g, '$1 $2');
  value = value.replace(/([A-Za-z])(\d)/g, '$1 $2');
  value = value.replace(/(\d)([A-Za-z])/g, '$1 $2');
  value = value.replaceAll('_', ' ').replaceAll('-', ' ');
  const humanized = value.split(/\s+/).filter(Boolean).map(capitalize).join(' ');
  return humanized || slug;
}

function capitalize(part: string): string {
  return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
}

/**
 * Heuristic 2v2/team-format warning (legacy _warn_if_likely_2v2), returned
 * as data instead of printed.
 */
export function likely2v2Warning(participantNames: readonly string[]): string | null {
  const names = participantNames.map((n) => n.trim()).filter(Boolean);
  if (names.length < 8) return null;
  const pipeLike = names.filter((n) => n.includes('|') || n.includes(' / ') || n.includes(' & ')).length;
  const longNames = names.filter((n) => n.split(/\s+/).length >= 4).length;
  const suspiciousRatio = Math.max(pipeLike / names.length, longNames / names.length);
  if (
    pipeLike >= Math.max(3, Math.floor(names.length / 4)) ||
    longNames >= Math.max(4, Math.floor(names.length / 3)) ||
    suspiciousRatio >= 0.4
  ) {
    return `${pipeLike}/${names.length} names contain team separators, ${longNames}/${names.length} have 4+ words — this may be a 2v2/team tournament.`;
  }
  return null;
}
