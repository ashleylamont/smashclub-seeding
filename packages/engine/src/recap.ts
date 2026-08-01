/**
 * Post-event recap: turns one club *night* into a ranked list of facts.
 *
 * Pure, like the rest of the engine — it receives already-loaded rows and
 * returns structured facts, so the same code can back the recap page, a share
 * image, a chat post, or an end-of-year wrap-up without any of them
 * re-deriving what counts as an upset.
 *
 * Two properties the callers depend on:
 *
 * - **Ratings are optional.** Right after a bracket finishes, identities may
 *   still be in the review queue and the newest recompute may not include the
 *   night yet. Every seed- and score-based fact is computed without touching
 *   `ratingEvents`, so a recap exists the moment Challonge reports results and
 *   simply gains rating-flavoured facts later. Nothing here throws on empty
 *   rating input.
 * - **Excluded sets are excluded from facts too.** A DQ is not a clean sweep
 *   and a walkover is not an upset, so anything marked `excludedFromRatings`
 *   is dropped before any fact looks at it — the same rule ratings use.
 *
 * Facts carry a `notability` in [0, 1] so a surface with room for four cards
 * can take the top four deterministically, rather than each surface inventing
 * its own idea of what was interesting.
 */

import { eventKeyOf } from './events';
import { winProbability } from './glicko2';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface RecapTournament {
  id: string;
  name: string;
  /** ISO 8601. Brackets sharing an `eventKeyOf` are one night. */
  eventDate: string | null;
  isRookie: boolean;
  /** Challonge's own state; only 'complete' brackets get placement facts. */
  challongeState: string | null;
}

export interface RecapParticipant {
  id: string;
  tournamentId: string;
  /** Null while identity is unresolved; seed-based facts still work. */
  playerId: string | null;
  /** Already public-formatted by the caller. */
  name: string;
  companyCode: string | null;
  characters: readonly string[];
  seed: number | null;
  finalRank: number | null;
}

export interface RecapSet {
  id: string;
  tournamentId: string;
  /** Positive = winners bracket, negative = losers. */
  round: number | null;
  /** Challonge's bracket ordering hint; the tie-break for elimination order. */
  suggestedPlayOrder?: number | null;
  identifier: string | null;
  state: string;
  p1ParticipantId: string | null;
  p2ParticipantId: string | null;
  winner: 1 | 2 | null;
  scoresCsv: string | null;
  excludedFromRatings: boolean;
  completedAt: string | null;
}

export interface RecapRatingEvent {
  playerId: string;
  setId: string | null;
  tournamentId: string;
  isDecay: boolean;
  won: boolean | null;
  preRating: number;
  postRating: number;
  preRd: number;
  postRd: number;
}

/**
 * Career context from *before* this night. Optional: without it the recap
 * simply omits rivalry, debut and milestone facts.
 */
export interface RecapHistory {
  /** Rated sets played before tonight, per player. */
  priorSetCounts: ReadonlyMap<string, number>;
  /** Nights attended before tonight, per player. */
  priorEventCounts: ReadonlyMap<string, number>;
  /** Highest rating ever held before tonight, per player. */
  priorPeakRating: ReadonlyMap<string, number>;
  /**
   * Head-to-head record before tonight, keyed by {@link pairKey}. Wins are
   * recorded for the lexicographically smaller player id (`aWins`).
   */
  priorMeetings: ReadonlyMap<string, { aWins: number; bWins: number }>;
}

export interface RecapRankMovement {
  playerId: string;
  rank: number;
  /** Null when the player had no rating before this night. */
  previousRank: number | null;
}

export interface RecapInput {
  tournaments: readonly RecapTournament[];
  participants: readonly RecapParticipant[];
  sets: readonly RecapSet[];
  /** May be empty — see the module note on optional ratings. */
  ratingEvents?: readonly RecapRatingEvent[];
  history?: RecapHistory;
  /** Rank movement recorded by the recompute (already night-aware). */
  rankMovement?: readonly RecapRankMovement[];
  /** Entrant counts for earlier nights, for the turnout comparison. */
  priorTurnouts?: readonly { eventKey: string; entrants: number }[];
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** A player as a fact refers to them — enough to render a chip or a link. */
export interface RecapPlayerRef {
  playerId: string | null;
  name: string;
  companyCode: string | null;
  characters: readonly string[];
}

export type RecapFact =
  /**
   * `derived` marks a podium worked out from elimination order rather than
   * reported by Challonge — see {@link deriveBracketOutcome}.
   */
  | { kind: 'podium'; tournamentId: string; derived: boolean; places: Array<{ player: RecapPlayerRef; place: number; seed: number | null }> }
  /** `stage` is the set's place in the bracket as words ("the winners final"). */
  | { kind: 'seed_upset'; tournamentId: string; winner: RecapPlayerRef; loser: RecapPlayerRef; winnerSeed: number; loserSeed: number; stage: string | null; score: string | null }
  | { kind: 'rating_upset'; tournamentId: string; winner: RecapPlayerRef; loser: RecapPlayerRef; probability: number; ratingGap: number; stage: string | null; score: string | null }
  | { kind: 'losers_run'; tournamentId: string; player: RecapPlayerRef; wins: number; finalRank: number | null }
  | { kind: 'overperformer'; tournamentId: string; player: RecapPlayerRef; seed: number; finalRank: number; placesGained: number }
  | { kind: 'nailbiter'; tournamentId: string; winner: RecapPlayerRef; loser: RecapPlayerRef; score: string; stage: string | null }
  | { kind: 'clean_sweep'; tournamentId: string; player: RecapPlayerRef; sets: number }
  | { kind: 'biggest_climb'; tournamentId: string; player: RecapPlayerRef; gained: number; from: number; to: number }
  | { kind: 'mover'; tournamentId: null; player: RecapPlayerRef; rank: number; previousRank: number; placesGained: number }
  /** `a` is always the winner of tonight's meeting, and `aWins` includes it. */
  | { kind: 'rivalry'; tournamentId: string; a: RecapPlayerRef; b: RecapPlayerRef; meetings: number; aWins: number; bWins: number }
  /** Tonight's winner had never beaten this opponent — 0 for `priorLosses`. */
  | { kind: 'breakthrough'; tournamentId: string; winner: RecapPlayerRef; loser: RecapPlayerRef; priorLosses: number; stage: string | null; score: string | null }
  | { kind: 'debut'; tournamentId: string; players: RecapPlayerRef[] }
  | { kind: 'milestone'; tournamentId: string; player: RecapPlayerRef; milestone: 'sets' | 'events' | 'peak_rating'; value: number }
  | { kind: 'turnout'; tournamentId: null; entrants: number; previousBest: number | null; isRecord: boolean }
  /** `runSets`/`gamesDropped` describe the champion's whole night, when known. */
  | { kind: 'grand_finals'; tournamentId: string; winner: RecapPlayerRef; loser: RecapPlayerRef; score: string | null; bracketReset: boolean; runSets: number; gamesDropped: number | null };

export type RecapFactKind = RecapFact['kind'];

/** A fact plus the metadata every surface needs to order and key it. */
export interface RankedRecapFact {
  /** Stable across recomputes — safe as a React key. */
  id: string;
  /** 0..1. Surfaces take the top N. */
  notability: number;
  fact: RecapFact;
}

export interface RecapResult {
  eventKey: string | null;
  /** Every bracket that ran on this night, main first. */
  tournaments: readonly RecapTournament[];
  entrants: number;
  setsPlayed: number;
  /** True once every bracket of the night is complete on Challonge. */
  isComplete: boolean;
  facts: RankedRecapFact[];
}

// ---------------------------------------------------------------------------
// Score parsing
// ---------------------------------------------------------------------------

export interface ParsedScore {
  /** Games won by player 1 and player 2. */
  p1: number;
  p2: number;
  /** True when the format could not be read at all. */
  unknown: boolean;
}

/**
 * Read Challonge's `scores_csv`, which arrives in two shapes depending on how
 * the bracket was run:
 *
 *   "3-1"            a set score — games won by each side
 *   "1-0,0-1,1-0"    per-game scores — the set score is who won more games
 *
 * Both are common in the club's history, and they are not distinguishable by
 * anything but arity, so a single pair is read as the set score and multiple
 * pairs are tallied. Negative numbers are Challonge's forfeit convention
 * (see `scoresIndicateForfeit`); a forfeit has no game story worth telling, so
 * it reads as unknown rather than as a scoreline.
 */
export function parseScoresCsv(scoresCsv: string | null | undefined): ParsedScore {
  const unknown: ParsedScore = { p1: 0, p2: 0, unknown: true };
  if (!scoresCsv) return unknown;

  const pairs: Array<[number, number]> = [];
  for (const part of scoresCsv.split(',')) {
    const match = part.trim().match(/^(-?\d+)-(-?\d+)$/);
    if (!match) return unknown;
    const a = Number(match[1]);
    const b = Number(match[2]);
    if (a < 0 || b < 0) return unknown;
    pairs.push([a, b]);
  }
  if (pairs.length === 0) return unknown;
  if (pairs.length === 1) {
    const [a, b] = pairs[0]!;
    return { p1: a, p2: b, unknown: false };
  }
  let p1 = 0;
  let p2 = 0;
  for (const [a, b] of pairs) {
    if (a > b) p1 += 1;
    else if (b > a) p2 += 1;
  }
  return { p1, p2, unknown: false };
}

/** Head-to-head map key: player ids sorted, so the pair is order-independent. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** A completed, rateable set with both sides resolved to participants. */
interface PlayedSet {
  set: RecapSet;
  winner: RecapParticipant;
  loser: RecapParticipant;
  /** Games, from the winner's perspective. */
  winnerGames: number;
  loserGames: number;
  scoreKnown: boolean;
}

const refOf = (p: RecapParticipant): RecapPlayerRef => ({
  playerId: p.playerId,
  name: p.name,
  companyCode: p.companyCode,
  characters: p.characters,
});

/** Winner's score as it should be shown: always "3-1", never "1-3". */
const scoreText = (played: PlayedSet): string | null =>
  played.scoreKnown ? `${played.winnerGames}-${played.loserGames}` : null;

/** The extent of one bracket's rounds: deepest winners and losers round. */
interface BracketRounds {
  maxRound: number;
  minRound: number;
}

/**
 * How much a set's stage should amplify a fact. Grand finals drama beats
 * round-one drama, and losers-bracket sets are elimination sets, so they
 * outrank a winners-side set of the same depth.
 */
function stageWeight(round: number | null, maxRound: number): number {
  if (round == null || maxRound <= 0) return 0.5;
  if (round < 0) return Math.min(1, 0.55 + (0.45 * -round) / Math.max(1, maxRound));
  return Math.min(1, 0.35 + (0.5 * round) / Math.max(1, maxRound));
}

/**
 * A round as words, for copy: "the grand final", "the winners semis",
 * "losers round 2".
 *
 * "W3" means nothing to most of the room; where a bracket stands relative to
 * its end is what makes a result a story, and that takes knowing how deep this
 * bracket goes — hence the per-bracket extents rather than a global number.
 * Approximate below the last three rounds, which is where names stop existing
 * anyway.
 */
export function stageName(round: number | null, rounds: BracketRounds): string | null {
  if (round == null) return null;
  if (round > 0) {
    if (round === rounds.maxRound) return 'the grand final';
    if (round === rounds.maxRound - 1) return 'the winners final';
    if (round === rounds.maxRound - 2) return 'the winners semis';
    return `winners round ${round}`;
  }
  if (round === rounds.minRound) return 'the losers final';
  if (round === rounds.minRound + 1) return 'the losers semis';
  return `losers round ${-round}`;
}

/** Squash an unbounded magnitude into 0..1 without a hard ceiling. */
const saturate = (value: number, scale: number): number =>
  value <= 0 ? 0 : value / (value + scale);

/**
 * Where a set sits in the order a bracket was played: when it finished, then
 * Challonge's own play-order hint, then the position the caller supplied.
 *
 * That last component matters more than it looks. The default sync source
 * carries neither per-match timestamps nor `suggested_play_order`, so on a real
 * club bracket the first two are frequently identical across every set of a
 * tournament and the tie-break is all there is. Callers pass sets in bracket
 * order, so the index is a meaningful last resort — and, crucially, a stable
 * one. An earlier version fell back to the set's uuid, which is arbitrary: two
 * places that both needed to know "which set decided this bracket" could and
 * did disagree, so a recap could name one player on its podium and a different
 * one as the grand-final winner.
 */
type OrderKey = [string, number, number];

function setOrderKey(set: RecapSet, index: number): OrderKey {
  return [set.completedAt ?? '', set.suggestedPlayOrder ?? 0, index];
}

function compareOrderKeys(a: OrderKey, b: OrderKey): number {
  return a[0].localeCompare(b[0]) || a[1] - b[1] || a[2] - b[2];
}

/** What a bracket, read on its own terms, says happened. */
export interface BracketOutcome {
  /** Placement per participant id, champion first. */
  placements: Map<string, number>;
  /** The set that decided the bracket. */
  decider: RecapSet;
  /** True when the final needed more than one set — a bracket reset. */
  bracketReset: boolean;
}

/**
 * Reads a bracket's result out of its own sets.
 *
 * There is deliberately ONE of these. Both the podium and the grand-final fact
 * need to know who won a bracket, and when they worked it out separately they
 * could disagree — on real club data, where sets often carry neither a
 * timestamp nor a play-order hint, two different tie-breaks named two different
 * champions and the recap contradicted itself on the same page.
 *
 * Placements exist because the default sync source is the embedded `/module`
 * bracket page, which carries no `final_rank` at all (only the opt-in API path
 * does). Without deriving them, most of the club's history would have no podium
 * — the one fact a recap most obviously needs.
 *
 * The rule is elimination order: you are out when you lose your last set, and
 * the longer you lasted the better you placed. That is exact for the top of a
 * double-elimination bracket — the grand-final loser is second, the losers-final
 * loser third — and approximate further down, where real brackets award tied
 * places anyway. Callers use it for the podium and not for anything that reads a
 * placement as precise (see `collectOverperformers`).
 *
 * The champion is the winner of the *final* — the last set of the highest round
 * — and explicitly not "the player who never lost". In double elimination the
 * winner frequently has a loss: anyone coming up through losers has one by
 * definition, and a grand final that goes to a bracket reset means the eventual
 * champion lost a set on the day. Keying on undefeatedness dropped the podium
 * from exactly the most dramatic nights.
 *
 * Returns null for a bracket with no completed sets to read.
 */
export function deriveBracketOutcome(sets: readonly RecapSet[]): BracketOutcome | null {
  const lastLoss = new Map<string, OrderKey>();
  let final: { set: RecapSet; winner: string; key: OrderKey } | null = null;
  let finalRoundSets = 0;

  sets.forEach((set, index) => {
    if (set.state !== 'complete' || set.winner == null || set.excludedFromRatings) return;
    const p1 = set.p1ParticipantId;
    const p2 = set.p2ParticipantId;
    if (!p1 || !p2) return;
    const winner = set.winner === 1 ? p1 : p2;
    const loser = set.winner === 1 ? p2 : p1;

    const key = setOrderKey(set, index);
    const existing = lastLoss.get(loser);
    if (!existing || compareOrderKeys(key, existing) > 0) lastLoss.set(loser, key);

    /*
     * The final is the highest round; a bracket reset puts two sets there and
     * the later one decides it. Round rather than raw time, because a bracket
     * can finish out a lower-round set after the final has been played.
     */
    const round = set.round ?? 0;
    const bestRound = final?.set.round ?? 0;
    if (final === null || round > bestRound) {
      final = { set, winner, key };
      finalRoundSets = 1;
    } else if (round === bestRound) {
      finalRoundSets += 1;
      if (compareOrderKeys(key, final.key) > 0) final = { set, winner, key };
    }
  });

  if (final === null) return null;
  const decided = final as { set: RecapSet; winner: string; key: OrderKey };

  const placements = new Map<string, number>([[decided.winner, 1]]);
  const eliminated = [...lastLoss.entries()]
    .filter(([participantId]) => participantId !== decided.winner)
    .sort((a, b) => compareOrderKeys(b[1], a[1]));
  eliminated.forEach(([participantId], index) => placements.set(participantId, index + 2));

  return { placements, decider: decided.set, bracketReset: finalRoundSets > 1 };
}

export const RECAP_ENGINE_VERSION = '1';

/**
 * How many facts of each kind a recap may carry.
 *
 * Without this a busy night buries everything interesting: a bracket where most
 * sets go to a deciding game produces a dozen near-identical "went the
 * distance" cards, and the one genuine upset ends up below the fold. The point
 * of a recap is selection, so each kind keeps only its most notable few and the
 * rest are dropped.
 *
 * Kinds that are already bounded by construction — one podium and one grand
 * final per bracket, one turnout comparison per night — are left unlimited.
 */
const FACT_LIMITS: Record<RecapFactKind, number> = {
  podium: Number.POSITIVE_INFINITY,
  grand_finals: Number.POSITIVE_INFINITY,
  clean_sweep: Number.POSITIVE_INFINITY,
  turnout: 1,
  biggest_climb: 1,
  debut: 1,
  seed_upset: 3,
  rating_upset: 3,
  milestone: 3,
  mover: 3,
  nailbiter: 2,
  losers_run: 2,
  overperformer: 2,
  rivalry: 2,
  breakthrough: 2,
};

/** Keep the most notable few of each kind; assumes `facts` is already sorted. */
function limitByKind(facts: readonly RankedRecapFact[]): RankedRecapFact[] {
  const kept: RankedRecapFact[] = [];
  const seen = new Map<RecapFactKind, number>();
  for (const entry of facts) {
    const count = seen.get(entry.fact.kind) ?? 0;
    if (count >= FACT_LIMITS[entry.fact.kind]) continue;
    seen.set(entry.fact.kind, count + 1);
    kept.push(entry);
  }
  return kept;
}

// ---------------------------------------------------------------------------
// The recap
// ---------------------------------------------------------------------------

export function buildRecap(input: RecapInput): RecapResult {
  const { tournaments, participants, sets } = input;
  const ratingEvents = input.ratingEvents ?? [];

  const byId = new Map(participants.map((p) => [p.id, p]));
  /**
   * Main bracket first, then rookie: a night's headline result is the main
   * bracket's, and `eventDate` alone does not order them reliably.
   */
  const orderedTournaments = [...tournaments].sort(
    (a, b) => Number(a.isRookie) - Number(b.isRookie) || a.name.localeCompare(b.name),
  );
  const eventKey = orderedTournaments.find((t) => t.eventDate)?.eventDate ?? null;

  const played: PlayedSet[] = [];
  for (const set of sets) {
    if (set.state !== 'complete' || set.winner == null || set.excludedFromRatings) continue;
    const p1 = set.p1ParticipantId ? byId.get(set.p1ParticipantId) : undefined;
    const p2 = set.p2ParticipantId ? byId.get(set.p2ParticipantId) : undefined;
    if (!p1 || !p2) continue;
    const winner = set.winner === 1 ? p1 : p2;
    const loser = set.winner === 1 ? p2 : p1;
    const score = parseScoresCsv(set.scoresCsv);
    // scores_csv is always player1-first; flip it when player 2 won.
    const winnerGames = set.winner === 1 ? score.p1 : score.p2;
    const loserGames = set.winner === 1 ? score.p2 : score.p1;
    played.push({ set, winner, loser, winnerGames, loserGames, scoreKnown: !score.unknown });
  }

  /*
   * Each finished bracket read once, so every fact that depends on "who won
   * this bracket" agrees with every other. Placements are Challonge's where it
   * reported them and the bracket's own where it did not — which is most of the
   * time, since the default sync source carries none. `derivedFor` records
   * which brackets were worked out rather than reported, so facts that need a
   * precise placement can decline to use one.
   */
  const outcomes = new Map<string, BracketOutcome>();
  const placement = new Map<string, number>();
  const derivedFor = new Set<string>();
  for (const tournament of orderedTournaments) {
    if (tournament.challongeState === 'complete') {
      const outcome = deriveBracketOutcome(sets.filter((s) => s.tournamentId === tournament.id));
      if (outcome) outcomes.set(tournament.id, outcome);
    }
    const entries = participants.filter((p) => p.tournamentId === tournament.id);
    const reported = entries.filter((p) => p.finalRank != null);
    if (reported.length > 0) {
      for (const p of reported) placement.set(p.id, p.finalRank!);
      continue;
    }
    const outcome = outcomes.get(tournament.id);
    if (!outcome) continue;
    derivedFor.add(tournament.id);
    for (const [participantId, place] of outcome.placements) placement.set(participantId, place);
  }

  /*
   * Round extents per bracket, so stage names and stage weights are relative to
   * the bracket a set was actually in — a rookie bracket's final is its final,
   * however deep the main bracket ran the same night.
   */
  const roundsByTournament = new Map<string, BracketRounds>();
  for (const set of sets) {
    const round = set.round ?? 0;
    const extent = roundsByTournament.get(set.tournamentId) ?? { maxRound: 0, minRound: 0 };
    extent.maxRound = Math.max(extent.maxRound, round);
    extent.minRound = Math.min(extent.minRound, round);
    roundsByTournament.set(set.tournamentId, extent);
  }
  const stageOf = (playedSet: PlayedSet): string | null =>
    stageName(
      playedSet.set.round,
      roundsByTournament.get(playedSet.set.tournamentId) ?? { maxRound: 0, minRound: 0 },
    );
  const weightOf = (playedSet: PlayedSet): number => {
    const extent = roundsByTournament.get(playedSet.set.tournamentId);
    const depth = extent ? Math.max(extent.maxRound, -extent.minRound) : 0;
    return stageWeight(playedSet.set.round, depth);
  };

  const facts: RankedRecapFact[] = [];
  const push = (id: string, notability: number, fact: RecapFact): void => {
    facts.push({ id, notability: Math.max(0, Math.min(1, notability)), fact });
  };

  collectPodiums(orderedTournaments, participants, placement, derivedFor, push);
  collectGrandFinals(played, outcomes, push);
  const deciderSetIds = new Set([...outcomes.values()].map((o) => o.decider.id));
  collectSeedUpsets(played, stageOf, weightOf, push);
  collectRatingUpsets(played, ratingEvents, stageOf, weightOf, push);
  collectNailbiters(played, deciderSetIds, stageOf, weightOf, push);
  collectLosersRuns(played, placement, push);
  collectOverperformers(orderedTournaments, participants, push);
  collectCleanSweeps(played, participants, placement, push);
  collectClimbs(played, ratingEvents, participants, push);
  collectMovers(input.rankMovement ?? [], participants, push);
  collectRivalries(played, input.history, push);
  collectBreakthroughs(played, input.history, stageOf, weightOf, push);
  collectDebutsAndMilestones(played, participants, ratingEvents, input.history, push);
  collectTurnout(participants, orderedTournaments, input.priorTurnouts ?? [], push);

  facts.sort((a, b) => b.notability - a.notability || a.id.localeCompare(b.id));

  return {
    eventKey: eventKey ? eventKeyOf(eventKey) : null,
    tournaments: orderedTournaments,
    entrants: participants.length,
    setsPlayed: played.length,
    isComplete:
      orderedTournaments.length > 0 && orderedTournaments.every((t) => t.challongeState === 'complete'),
    facts: limitByKind(facts),
  };
}

type Push = (id: string, notability: number, fact: RecapFact) => void;

function collectPodiums(
  tournaments: readonly RecapTournament[],
  participants: readonly RecapParticipant[],
  placement: ReadonlyMap<string, number>,
  derivedFor: ReadonlySet<string>,
  push: Push,
): void {
  for (const tournament of tournaments) {
    const placed = participants
      .filter((p) => p.tournamentId === tournament.id && placement.has(p.id))
      .sort((a, b) => placement.get(a.id)! - placement.get(b.id)!)
      .slice(0, 3);
    if (placed.length === 0) continue;
    // The main bracket's podium is the night's headline; the rookie one sits
    // just below it rather than competing with the drama facts.
    push(`podium:${tournament.id}`, tournament.isRookie ? 0.9 : 1, {
      kind: 'podium',
      tournamentId: tournament.id,
      derived: derivedFor.has(tournament.id),
      places: placed.map((p) => ({ player: refOf(p), place: placement.get(p.id)!, seed: p.seed })),
    });
  }
}

/**
 * The set that decided each finished bracket. In double elimination the
 * losers-side finalist must win twice, so two sets share the highest round —
 * that is a bracket reset, and it is the most notable shape a final can have.
 *
 * Which set that was comes from {@link deriveBracketOutcome}, the same read the
 * podium is built from, so the two can never name different champions.
 */
function collectGrandFinals(
  played: readonly PlayedSet[],
  outcomes: ReadonlyMap<string, BracketOutcome>,
  push: Push,
): void {
  const playedById = new Map(played.map((p) => [p.set.id, p]));
  for (const [tournamentId, outcome] of outcomes) {
    // A bracket whose rounds are all zero or negative has no final worth
    // naming — that is not a shape the club's brackets take, but the guard
    // keeps a malformed one from producing a nonsense card.
    if ((outcome.decider.round ?? 0) <= 0) continue;
    const decider = playedById.get(outcome.decider.id);
    if (!decider) continue;

    /*
     * The champion's whole night, so the card can tell the run and not just
     * the last set. Games dropped is only claimed when every scoreline was
     * readable — an unknown score could hide anything.
     */
    const run = played.filter(
      (p) =>
        p.set.tournamentId === tournamentId &&
        (p.winner.id === decider.winner.id || p.loser.id === decider.winner.id),
    );
    const runSets = run.length;
    const gamesDropped = run.every((p) => p.scoreKnown)
      ? run.reduce(
          (sum, p) => sum + (p.winner.id === decider.winner.id ? p.loserGames : p.winnerGames),
          0,
        )
      : null;

    push(`grand_finals:${tournamentId}`, outcome.bracketReset ? 0.95 : 0.7, {
      kind: 'grand_finals',
      tournamentId,
      winner: refOf(decider.winner),
      loser: refOf(decider.loser),
      score: scoreText(decider),
      bracketReset: outcome.bracketReset,
      runSets,
      gamesDropped,
    });
  }
}

/**
 * Seed inversions. This is the upset measure that works with no rating data at
 * all, so it is what a just-finished bracket leads with.
 *
 * Magnitude is the *ratio* of seeds, not their difference: 16 beating 1 is a
 * far bigger story than 32 beating 17, though both are fifteen places.
 */
function collectSeedUpsets(
  played: readonly PlayedSet[],
  stageOf: (p: PlayedSet) => string | null,
  weightOf: (p: PlayedSet) => number,
  push: Push,
): void {
  for (const p of played) {
    const winnerSeed = p.winner.seed;
    const loserSeed = p.loser.seed;
    if (winnerSeed == null || loserSeed == null || winnerSeed <= loserSeed) continue;
    const ratio = Math.log2(winnerSeed / loserSeed);
    const notability = 0.45 * saturate(ratio, 1.6) + 0.35 * weightOf(p) + 0.1;
    push(`seed_upset:${p.set.id}`, notability, {
      kind: 'seed_upset',
      tournamentId: p.set.tournamentId,
      winner: refOf(p.winner),
      loser: refOf(p.loser),
      winnerSeed,
      loserSeed,
      stage: stageOf(p),
      score: scoreText(p),
    });
  }
}

/**
 * Upsets by rating: how unlikely the result was given what we knew going in.
 *
 * Pre-set ratings come from the rating events themselves, which is the only
 * place the *going-in* number survives — the player's current rating already
 * has tonight's results baked in.
 */
function collectRatingUpsets(
  played: readonly PlayedSet[],
  ratingEvents: readonly RecapRatingEvent[],
  stageOf: (p: PlayedSet) => string | null,
  weightOf: (p: PlayedSet) => number,
  push: Push,
): void {
  if (ratingEvents.length === 0) return;
  const bySet = new Map<string, RecapRatingEvent[]>();
  for (const event of ratingEvents) {
    if (event.isDecay || !event.setId) continue;
    const list = bySet.get(event.setId);
    if (list) list.push(event);
    else bySet.set(event.setId, [event]);
  }

  for (const p of played) {
    const events = bySet.get(p.set.id);
    if (!events || events.length < 2) continue;
    const winnerEvent = events.find((e) => e.playerId === p.winner.playerId);
    const loserEvent = events.find((e) => e.playerId === p.loser.playerId);
    if (!winnerEvent || !loserEvent) continue;

    const probability = winProbability(
      { rating: winnerEvent.preRating, rd: winnerEvent.preRd, vol: 0 },
      { rating: loserEvent.preRating, rd: loserEvent.preRd, vol: 0 },
    );
    // Only genuine longshots; an even set is not an upset.
    if (probability > 0.35) continue;
    const notability = 0.6 * (1 - probability / 0.35) + 0.3 * weightOf(p) + 0.1;
    push(`rating_upset:${p.set.id}`, notability, {
      kind: 'rating_upset',
      tournamentId: p.set.tournamentId,
      winner: refOf(p.winner),
      loser: refOf(p.loser),
      probability,
      ratingGap: loserEvent.preRating - winnerEvent.preRating,
      stage: stageOf(p),
      score: scoreText(p),
    });
  }
}

/** Sets that went to a deciding game — 3-2, 2-1, and so on. */
function collectNailbiters(
  played: readonly PlayedSet[],
  deciderSetIds: ReadonlySet<string>,
  stageOf: (p: PlayedSet) => string | null,
  weightOf: (p: PlayedSet) => number,
  push: Push,
): void {
  for (const p of played) {
    if (!p.scoreKnown) continue;
    // The set that decided a bracket already has its own card; a nailbiter
    // card for the same set tells the same story twice.
    if (deciderSetIds.has(p.set.id)) continue;
    if (p.winnerGames < 2 || p.loserGames !== p.winnerGames - 1) continue;
    push(`nailbiter:${p.set.id}`, 0.25 + 0.5 * weightOf(p), {
      kind: 'nailbiter',
      tournamentId: p.set.tournamentId,
      winner: refOf(p.winner),
      loser: refOf(p.loser),
      score: `${p.winnerGames}-${p.loserGames}`,
      stage: stageOf(p),
    });
  }
}

/**
 * Runs through the losers bracket, where every set is an elimination set.
 * Counted as wins in negative rounds, which is the shape of "sent to losers
 * early and fought all the way back".
 */
function collectLosersRuns(
  played: readonly PlayedSet[],
  placement: ReadonlyMap<string, number>,
  push: Push,
): void {
  const runs = new Map<string, { participant: RecapParticipant; wins: number }>();
  for (const p of played) {
    if ((p.set.round ?? 0) >= 0) continue;
    const key = `${p.set.tournamentId}:${p.winner.id}`;
    const existing = runs.get(key);
    if (existing) existing.wins += 1;
    else runs.set(key, { participant: p.winner, wins: 1 });
  }
  for (const [key, run] of runs) {
    if (run.wins < 3) continue;
    push(`losers_run:${key}`, Math.min(0.9, 0.4 + 0.12 * run.wins), {
      kind: 'losers_run',
      tournamentId: run.participant.tournamentId,
      player: refOf(run.participant),
      wins: run.wins,
      finalRank: placement.get(run.participant.id) ?? null,
    });
  }
}

/**
 * Seed performance: placing better than you were seeded. Expressed in places
 * gained so it reads plainly, but scored on the ratio for the same reason seed
 * upsets are.
 *
 * Deliberately reads `finalRank` — the placement Challonge reported — and not
 * the derived one. "Seeded 12th, finished 4th" is a claim about an exact
 * placement, and {@link derivePlacements} is only exact at the top of the
 * bracket, so a derived 4th is not something to put a number on.
 */
function collectOverperformers(
  tournaments: readonly RecapTournament[],
  participants: readonly RecapParticipant[],
  push: Push,
): void {
  for (const tournament of tournaments) {
    if (tournament.challongeState !== 'complete') continue;
    for (const p of participants) {
      if (p.tournamentId !== tournament.id) continue;
      if (p.seed == null || p.finalRank == null || p.finalRank >= p.seed) continue;
      const placesGained = p.seed - p.finalRank;
      // A winner's story is already told by the podium fact.
      if (p.finalRank === 1) continue;
      const ratio = Math.log2(p.seed / p.finalRank);
      push(`overperformer:${tournament.id}:${p.id}`, 0.25 + 0.45 * saturate(ratio, 1.4), {
        kind: 'overperformer',
        tournamentId: tournament.id,
        player: refOf(p),
        seed: p.seed,
        finalRank: p.finalRank,
        placesGained,
      });
    }
  }
}

/**
 * Won the bracket without dropping a game. Needs readable scores for every set
 * they played — an unknown scoreline could hide a dropped game, so an
 * unverifiable sweep is not claimed.
 */
function collectCleanSweeps(
  played: readonly PlayedSet[],
  participants: readonly RecapParticipant[],
  placement: ReadonlyMap<string, number>,
  push: Push,
): void {
  const champions = participants.filter((p) => placement.get(p.id) === 1);
  for (const champion of champions) {
    const theirs = played.filter(
      (p) => p.winner.id === champion.id || p.loser.id === champion.id,
    );
    if (theirs.length < 3) continue;
    if (theirs.some((p) => !p.scoreKnown)) continue;
    const dropped = theirs.some((p) => p.loser.id === champion.id || p.loserGames > 0);
    if (dropped) continue;
    push(`clean_sweep:${champion.tournamentId}:${champion.id}`, Math.min(0.92, 0.6 + 0.05 * theirs.length), {
      kind: 'clean_sweep',
      tournamentId: champion.tournamentId,
      player: refOf(champion),
      sets: theirs.length,
    });
  }
}

/** Who gained the most rating over the night. */
function collectClimbs(
  played: readonly PlayedSet[],
  ratingEvents: readonly RecapRatingEvent[],
  participants: readonly RecapParticipant[],
  push: Push,
): void {
  if (ratingEvents.length === 0 || played.length === 0) return;
  const playedSetIds = new Set(played.map((p) => p.set.id));
  const byPlayer = new Map<string, { first: RecapRatingEvent; last: RecapRatingEvent }>();
  for (const event of ratingEvents) {
    if (event.isDecay || !event.setId || !playedSetIds.has(event.setId)) continue;
    const existing = byPlayer.get(event.playerId);
    if (existing) existing.last = event;
    else byPlayer.set(event.playerId, { first: event, last: event });
  }

  const participantByPlayer = new Map<string, RecapParticipant>();
  for (const p of participants) if (p.playerId) participantByPlayer.set(p.playerId, p);

  let best: { player: RecapParticipant; gained: number; from: number; to: number } | null = null;
  for (const [playerId, span] of byPlayer) {
    const participant = participantByPlayer.get(playerId);
    if (!participant) continue;
    const gained = span.last.postRating - span.first.preRating;
    if (gained <= 0) continue;
    if (!best || gained > best.gained) {
      best = { player: participant, gained, from: span.first.preRating, to: span.last.postRating };
    }
  }
  if (!best) return;
  push(`biggest_climb:${best.player.id}`, 0.3 + 0.5 * saturate(best.gained, 60), {
    kind: 'biggest_climb',
    tournamentId: best.player.tournamentId,
    player: refOf(best.player),
    gained: best.gained,
    from: best.from,
    to: best.to,
  });
}

/**
 * Leaderboard places gained. Uses the movement the recompute already recorded
 * against a withheld-night replay, so it reports what the games did.
 */
function collectMovers(
  movement: readonly RecapRankMovement[],
  participants: readonly RecapParticipant[],
  push: Push,
): void {
  const participantByPlayer = new Map<string, RecapParticipant>();
  for (const p of participants) if (p.playerId) participantByPlayer.set(p.playerId, p);

  const climbers = movement
    .filter((m) => m.previousRank != null && m.previousRank > m.rank)
    .map((m) => ({ ...m, gained: m.previousRank! - m.rank }))
    .sort((a, b) => b.gained - a.gained);

  for (const mover of climbers.slice(0, 3)) {
    const participant = participantByPlayer.get(mover.playerId);
    if (!participant) continue;
    push(`mover:${mover.playerId}`, 0.2 + 0.4 * saturate(mover.gained, 4), {
      kind: 'mover',
      tournamentId: null,
      player: refOf(participant),
      rank: mover.rank,
      previousRank: mover.previousRank!,
      placesGained: mover.gained,
    });
  }
}

/** Repeat meetings — the club's running head-to-heads. */
function collectRivalries(played: readonly PlayedSet[], history: RecapHistory | undefined, push: Push): void {
  if (!history) return;
  for (const p of played) {
    const winnerId = p.winner.playerId;
    const loserId = p.loser.playerId;
    if (!winnerId || !loserId) continue;
    const key = pairKey(winnerId, loserId);
    const prior = history.priorMeetings.get(key);
    if (!prior) continue;
    const meetings = prior.aWins + prior.bWins + 1;
    if (meetings < 3) continue;
    // `aWins` belongs to the lexicographically smaller id; resolve it to the
    // set's winner so the caller never has to redo the comparison.
    const winnerIsA = winnerId < loserId;
    const winnerPriorWins = winnerIsA ? prior.aWins : prior.bWins;
    const loserPriorWins = winnerIsA ? prior.bWins : prior.aWins;
    // A first-ever win over a long-time tormentor is the breakthrough fact's
    // story; telling it here too would put the same set on two cards.
    if (winnerPriorWins === 0 && loserPriorWins >= 2) continue;
    push(`rivalry:${p.set.id}`, Math.min(0.85, 0.3 + 0.08 * meetings), {
      kind: 'rivalry',
      tournamentId: p.set.tournamentId,
      a: refOf(p.winner),
      b: refOf(p.loser),
      meetings,
      aWins: winnerPriorWins + 1,
      bWins: loserPriorWins,
    });
  }
}

/**
 * A first career win over an opponent who had always won before. Anyone who
 * has chased the same person across three club nights knows exactly why this
 * is a highlight and not a statistic.
 */
function collectBreakthroughs(
  played: readonly PlayedSet[],
  history: RecapHistory | undefined,
  stageOf: (p: PlayedSet) => string | null,
  weightOf: (p: PlayedSet) => number,
  push: Push,
): void {
  if (!history) return;
  // One breakthrough per pairing per night: beating them twice tonight is
  // still one story.
  const claimed = new Set<string>();
  for (const p of played) {
    const winnerId = p.winner.playerId;
    const loserId = p.loser.playerId;
    if (!winnerId || !loserId) continue;
    const key = pairKey(winnerId, loserId);
    if (claimed.has(key)) continue;
    const prior = history.priorMeetings.get(key);
    if (!prior) continue;
    const winnerIsA = winnerId < loserId;
    const winnerPriorWins = winnerIsA ? prior.aWins : prior.bWins;
    const priorLosses = winnerIsA ? prior.bWins : prior.aWins;
    if (winnerPriorWins > 0 || priorLosses < 2) continue;
    claimed.add(key);
    push(`breakthrough:${p.set.id}`, Math.min(0.85, 0.4 + 0.08 * priorLosses + 0.15 * weightOf(p)), {
      kind: 'breakthrough',
      tournamentId: p.set.tournamentId,
      winner: refOf(p.winner),
      loser: refOf(p.loser),
      priorLosses,
      stage: stageOf(p),
      score: scoreText(p),
    });
  }
}

/** First-timers, and career counters that ticked over tonight. */
function collectDebutsAndMilestones(
  played: readonly PlayedSet[],
  participants: readonly RecapParticipant[],
  ratingEvents: readonly RecapRatingEvent[],
  history: RecapHistory | undefined,
  push: Push,
): void {
  if (!history) return;

  // Someone who entered both brackets is two participants but one person, so
  // every per-player tally below folds on player id first.
  const firstParticipantPerPlayer = new Map<string, RecapParticipant>();
  for (const p of participants) {
    if (p.playerId && !firstParticipantPerPlayer.has(p.playerId)) {
      firstParticipantPerPlayer.set(p.playerId, p);
    }
  }

  const debutants = [...firstParticipantPerPlayer.values()].filter(
    (p) => (history.priorEventCounts.get(p.playerId!) ?? 0) === 0,
  );
  if (debutants.length > 0) {
    const tournamentId = debutants[0]!.tournamentId;
    push(`debut:${tournamentId}`, Math.min(0.6, 0.3 + 0.06 * debutants.length), {
      kind: 'debut',
      tournamentId,
      players: debutants.map(refOf),
    });
  }

  const setsPlayedTonight = new Map<string, number>();
  for (const p of played) {
    for (const side of [p.winner, p.loser]) {
      if (!side.playerId) continue;
      setsPlayedTonight.set(side.playerId, (setsPlayedTonight.get(side.playerId) ?? 0) + 1);
    }
  }

  // Round-number set counts crossed tonight.
  for (const [playerId, tonight] of setsPlayedTonight) {
    const participant = firstParticipantPerPlayer.get(playerId);
    if (!participant) continue;
    const before = history.priorSetCounts.get(playerId) ?? 0;
    const after = before + tonight;
    const milestone = [500, 250, 100, 50, 25].find((m) => before < m && after >= m);
    if (milestone === undefined) continue;
    push(`milestone_sets:${playerId}`, Math.min(0.75, 0.35 + milestone / 1000), {
      kind: 'milestone',
      tournamentId: participant.tournamentId,
      player: refOf(participant),
      milestone: 'sets',
      value: milestone,
    });
  }

  // Round-number attendance counts crossed tonight. Everyone present tonight
  // is one night further along, so this needs no per-player tally.
  for (const participant of firstParticipantPerPlayer.values()) {
    const before = history.priorEventCounts.get(participant.playerId!) ?? 0;
    const milestone = [100, 50, 25, 10].find((m) => before === m - 1);
    if (milestone === undefined) continue;
    push(`milestone_events:${participant.playerId!}`, Math.min(0.7, 0.3 + milestone / 200), {
      kind: 'milestone',
      tournamentId: participant.tournamentId,
      player: refOf(participant),
      milestone: 'events',
      value: milestone,
    });
  }

  // Career-high rating, from tonight's own events.
  const peakTonight = new Map<string, number>();
  for (const event of ratingEvents) {
    if (event.isDecay) continue;
    peakTonight.set(event.playerId, Math.max(peakTonight.get(event.playerId) ?? 0, event.postRating));
  }
  for (const [playerId, peak] of peakTonight) {
    const participant = firstParticipantPerPlayer.get(playerId);
    const priorPeak = history.priorPeakRating.get(playerId);
    // A player with no history has no career high to beat — that is a debut,
    // not a peak.
    if (!participant || priorPeak === undefined || peak <= priorPeak) continue;
    push(`milestone_peak:${playerId}`, 0.3 + 0.35 * saturate(peak - priorPeak, 40), {
      kind: 'milestone',
      tournamentId: participant.tournamentId,
      player: refOf(participant),
      milestone: 'peak_rating',
      value: peak,
    });
  }
}

/** How many turned up, against the club's previous nights. */
function collectTurnout(
  participants: readonly RecapParticipant[],
  tournaments: readonly RecapTournament[],
  priorTurnouts: readonly { eventKey: string; entrants: number }[],
  push: Push,
): void {
  if (participants.length === 0 || tournaments.length === 0) return;
  // One person entering both brackets of a night is one entrant. Unresolved
  // entries have no player id to dedupe on, so they count individually.
  const distinct = new Set<string>();
  let unresolved = 0;
  for (const p of participants) {
    if (p.playerId) distinct.add(p.playerId);
    else unresolved += 1;
  }
  const entrants = distinct.size + unresolved;
  const previousBest = priorTurnouts.reduce<number | null>(
    (max, t) => (max === null || t.entrants > max ? t.entrants : max),
    null,
  );
  const isRecord = previousBest !== null && entrants > previousBest;
  // Only worth a card when there is something to compare against.
  if (previousBest === null) return;
  push('turnout', isRecord ? 0.75 : 0.15, {
    kind: 'turnout',
    tournamentId: null,
    entrants,
    previousBest,
    isRecord,
  });
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

const ordinal = (n: number): string => {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
};

/** "in the winners final" / "" — stages read as a trailing clause or vanish. */
const inStage = (stage: string | null): string => (stage ? ` in ${stage}` : '');

/**
 * Fact copy, kept beside the facts themselves so the page, the share image and
 * any future chat post all say the same thing about the same night.
 *
 * The voice to hold: say what happened the way someone who was there would
 * retell it, with the numbers as evidence rather than as the sentence. "The
 * ratings gave them one chance in eight" lands; "probability 0.12" does not.
 */
export function formatFact(fact: RecapFact): { headline: string; detail: string } {
  switch (fact.kind) {
    case 'podium': {
      const [first, second, third] = fact.places;
      const runnersUp = [second, third].filter(Boolean).map((p) => p!.player.name);
      return {
        headline: first ? `${first.player.name} takes it` : 'Podium',
        detail:
          (first?.seed != null ? `Seeded ${ordinal(first.seed)}. ` : '') +
          (runnersUp.length > 0 ? `Ahead of ${runnersUp.join(' and ')}.` : ''),
      };
    }
    case 'seed_upset': {
      // A four-fold seed gap reads as a shock; anything less is a scalp.
      const shock = fact.winnerSeed >= fact.loserSeed * 4;
      return {
        headline: shock
          ? `${fact.winner.name} shocks ${fact.loser.name}`
          : `${fact.winner.name} takes down ${fact.loser.name}`,
        detail: `In as the ${ordinal(fact.winnerSeed)} seed against the ${ordinal(fact.loserSeed)}${inStage(fact.stage)}${fact.score ? ` — won ${fact.score}` : ''}.`,
      };
    }
    case 'rating_upset': {
      const oneIn = Math.max(2, Math.round(1 / Math.max(fact.probability, 0.01)));
      return {
        headline: `${fact.winner.name} beats the odds`,
        detail: `The ratings gave them one chance in ${oneIn} against ${fact.loser.name} — ${Math.round(fact.ratingGap)} points apart${inStage(fact.stage)}${fact.score ? `. Won ${fact.score}` : ''}.`,
      };
    }
    case 'losers_run':
      return {
        headline: `${fact.player.name}'s long road back`,
        detail: `Sent to the losers bracket, then won ${fact.wins} straight elimination sets${fact.finalRank != null ? ` to finish ${ordinal(fact.finalRank)}` : ''}.`,
      };
    case 'overperformer':
      return {
        headline: `${fact.player.name} outruns the seeding`,
        detail: `In as the ${ordinal(fact.seed)} seed, out in ${ordinal(fact.finalRank)} — ${fact.placesGained} places clear of expectations.`,
      };
    case 'nailbiter':
      return {
        headline: `${fact.winner.name} edges ${fact.loser.name}`,
        detail: `${fact.score}${inStage(fact.stage)}, down to the last game.`,
      };
    case 'clean_sweep':
      return {
        headline: `${fact.player.name} drops nothing`,
        detail: `${fact.sets} sets, not a single game lost, bracket closed.`,
      };
    case 'biggest_climb':
      return {
        headline: `${fact.player.name} owns the night`,
        detail: `Up ${Math.round(fact.gained)} rating in one evening, ${Math.round(fact.from)} → ${Math.round(fact.to)} — the biggest move on the board.`,
      };
    case 'mover':
      return {
        headline: `${fact.player.name} climbs to #${fact.rank}`,
        detail: `Up ${fact.placesGained} ${fact.placesGained === 1 ? 'place' : 'places'} from #${fact.previousRank} on tonight's games.`,
      };
    case 'rivalry': {
      const level = fact.aWins === fact.bWins;
      return {
        headline: `${fact.a.name} vs ${fact.b.name}, chapter ${fact.meetings}`,
        detail: level
          ? `${fact.a.name} took tonight's meeting, and the series is level at ${fact.aWins}–${fact.bWins}.`
          : `${fact.a.name} took tonight's meeting and leads the series ${fact.aWins}–${fact.bWins}.`,
      };
    }
    case 'breakthrough':
      return {
        headline: `${fact.winner.name} finally gets one`,
        detail: `${fact.priorLosses} career losses to ${fact.loser.name} and never a win — until tonight${inStage(fact.stage)}${fact.score ? `, ${fact.score}` : ''}.`,
      };
    case 'debut':
      return {
        headline:
          fact.players.length === 1
            ? `First night for ${fact.players[0]!.name}`
            : `${fact.players.length} first-timers in the bracket`,
        detail:
          fact.players.length === 1
            ? 'Welcome to the club.'
            : `First club night for ${fact.players.map((p) => p.name).join(', ')}.`,
      };
    case 'milestone':
      if (fact.milestone === 'peak_rating') {
        return {
          headline: `${fact.player.name} has never been rated higher`,
          detail: `A new career-high rating of ${Math.round(fact.value)}.`,
        };
      }
      if (fact.milestone === 'events') {
        return {
          headline: `${fact.player.name}'s ${ordinal(fact.value)} club night`,
          detail: `${fact.value} evenings of showing up.`,
        };
      }
      return {
        headline: `${fact.player.name}'s ${ordinal(fact.value)} career set`,
        detail: `Crossed ${fact.value} sets played tonight.`,
      };
    case 'turnout': {
      const tied = fact.previousBest != null && fact.entrants === fact.previousBest;
      return {
        headline: fact.isRecord ? 'The biggest night the club has run' : `${fact.entrants} in the building`,
        detail:
          fact.previousBest == null
            ? ''
            : fact.isRecord
              ? `${fact.entrants} entrants — past the old record of ${fact.previousBest}.`
              : tied
                ? `Ties the club's best night.`
                : `Best turnout is still ${fact.previousBest}.`,
      };
    }
    case 'grand_finals': {
      const run =
        fact.gamesDropped != null && fact.gamesDropped > 0
          ? ` ${fact.runSets} sets won on the night, ${fact.gamesDropped} ${fact.gamesDropped === 1 ? 'game' : 'games'} dropped along the way.`
          : '';
      return {
        headline: `${fact.winner.name} wins it all`,
        detail: `${fact.bracketReset ? 'It took a bracket reset. ' : ''}Beat ${fact.loser.name}${fact.score ? ` ${fact.score}` : ''} in the decider.${run}`,
      };
    }
  }
}
