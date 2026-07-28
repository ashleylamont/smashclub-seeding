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
