"""Glicko-2 prototype calculator for 1v1 match-level SSBU seeding."""

from __future__ import annotations

import csv
import datetime
import json
import math
import os
from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

from glicko2 import Player

from seeding_algorithm import COMPANY_CODES, PlayerInput, SeedingCalculator, clean_player_entry
from player_registry import get_player_registry

GCLICKO_PLAYER_ALIAS_FILE = '.glicko-player-aliases.json'
GCLICKO_PLAYER_ALIAS_VERSION = 1
GLICKO_STORED_ALIAS_FILE = '.glicko-stored-player-aliases.json'
GLICKO_STORED_ALIAS_VERSION = 1
GLICKO_EXPORT_DIR = 'glicko_exports'
MISSED_TOURNAMENT_RD_SCALE = 20  # Increase RD significantly when players miss tournaments
INVERSE_DIMINISHING_EXPONENT = 0.3  # Controls steepness of inverse-diminishing curve for match weights (lower = less aggressive)
ROOKIE_BRACKET_BASE_SCALE = 0.5  # Base scale for rookie bracket matches
ROOKIE_PARTIAL_PENALTY_THRESHOLD = 1400  # Rating at which partial penalty starts
ROOKIE_FULL_PENALTY_THRESHOLD = 1550  # Rating at which full penalty starts
ROOKIE_OVER_PENALTY_THRESHOLD = 1650  # Rating at which over-penalty starts


def _first_name_compatible(a: str, b: str) -> bool:
    a = a.lower()
    b = b.lower()
    return a == b or (len(a) >= 4 and b.startswith(a)) or (len(b) >= 4 and a.startswith(b))


def _name_alias_strength(query_name: str, candidate_name: str) -> float:
    query_parts = query_name.lower().split()
    candidate_parts = candidate_name.lower().split()
    if query_name.lower() == candidate_name.lower():
        return 1.0
    if not query_parts or not candidate_parts:
        return 0.0

    if len(query_parts) >= 2 and len(candidate_parts) >= 2 and _first_name_compatible(query_parts[0], candidate_parts[0]):
        query_last = query_parts[-1]
        candidate_last = candidate_parts[-1]
        if query_last == candidate_last:
            return 0.98
        if len(query_last) == 1 and candidate_last.startswith(query_last):
            return 0.95
        if len(candidate_last) == 1 and query_last.startswith(candidate_last):
            return 0.95

    if len(query_parts) == 1 and len(candidate_parts) >= 2 and query_parts[0] == candidate_parts[0]:
        return 0.78
    if len(candidate_parts) == 1 and len(query_parts) >= 2 and query_parts[0] == candidate_parts[0]:
        return 0.78

    return 0.0


def _load_glicko_player_aliases() -> Dict[str, Dict[str, str]]:
    if not os.path.exists(GCLICKO_PLAYER_ALIAS_FILE):
        return {}
    try:
        with open(GCLICKO_PLAYER_ALIAS_FILE, 'r') as f:
            payload = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}
    if payload.get('version') != GCLICKO_PLAYER_ALIAS_VERSION:
        return {}
    aliases = payload.get('aliases', {})
    return aliases if isinstance(aliases, dict) else {}


def _write_glicko_player_aliases(aliases: Dict[str, Dict[str, str]]) -> None:
    payload = {
        'version': GCLICKO_PLAYER_ALIAS_VERSION,
        'updated_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'aliases': aliases,
    }
    with open(GCLICKO_PLAYER_ALIAS_FILE, 'w') as f:
        json.dump(payload, f, indent=2, sort_keys=True)


def _load_glicko_stored_aliases() -> Dict[str, Dict[str, str]]:
    if not os.path.exists(GLICKO_STORED_ALIAS_FILE):
        return {}
    try:
        with open(GLICKO_STORED_ALIAS_FILE, 'r') as f:
            payload = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}
    if payload.get('version') != GLICKO_STORED_ALIAS_VERSION:
        return {}
    aliases = payload.get('aliases', {})
    return aliases if isinstance(aliases, dict) else {}


def _write_glicko_stored_aliases(aliases: Dict[str, Dict[str, str]]) -> None:
    payload = {
        'version': GLICKO_STORED_ALIAS_VERSION,
        'updated_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'aliases': aliases,
    }
    with open(GLICKO_STORED_ALIAS_FILE, 'w') as f:
        json.dump(payload, f, indent=2, sort_keys=True)


def _query_alias_key(name: str, company: Optional[str]) -> str:
    return f"{name.strip().lower()}::{(company or '').strip().lower()}"


def _stored_alias_key(name: str, company: str) -> str:
    return f"{name.strip().lower()}::{company.strip().lower()}"


def _patch_glicko2_player_volatility() -> None:
    """Patch the third-party Player._f implementation to use RD, not rating, in the volatility update."""

    def _fixed_f(self, x, delta, v, a):
        ex = math.exp(x)
        rd_sq = self._Player__rd ** 2
        num1 = ex * (delta**2 - rd_sq - v - ex)
        denom1 = 2 * ((rd_sq + v + ex) ** 2)
        return (num1 / denom1) - ((x - a) / (self._tau**2))

    Player._f = _fixed_f


_patch_glicko2_player_volatility()


@dataclass
class MatchResult:
    """Represents a single 1v1 set result from one player's perspective."""

    company: str
    player_name: str
    opponent_name: str
    opponent_company: str
    won: bool
    date: datetime.datetime
    tournament: str
    format: str = "1v1"
    pre_rating: float = 1500.0
    post_rating: float = 1500.0
    pre_rd: float = 350.0
    post_rd: float = 350.0
    pre_volatility: float = 0.06
    post_volatility: float = 0.06
    processing_index: int = 0
    tournament_index: int = 0
    is_decay_snapshot: bool = False  # True if this is a decay event, not a real match
    rating_change_weight: float = 1.0  # Inverse-diminishing weight based on match position in tournament

    @property
    def is_1v1(self) -> bool:
        return self.format == "1v1"

    @property
    def is_1v1_rookies(self) -> bool:
        return self.format == "1v1 Rookies"

    @property
    def is_2v2(self) -> bool:
        return False


@dataclass
class PlayerState:
    """Tracks a player's current Glicko state and activity metadata."""

    rating: Player
    last_played_date: Optional[datetime.datetime] = None
    last_tournament_index: Optional[int] = None
    match_count: int = 0
    wins: int = 0
    losses: int = 0
    main_match_count: int = 0
    rookie_match_count: int = 0


class GlickoCalculator(SeedingCalculator):
    """Prototype calculator that seeds players using conservative Glicko-2 ratings."""

    def __init__(self, matches_csv_path: str):
        self.matches_csv_path = matches_csv_path
        self.players: Dict[Tuple[str, str], PlayerState] = {}
        self.player_query_aliases = _load_glicko_player_aliases()
        self.stored_player_aliases = _load_glicko_stored_aliases()
        self.results = self._load_matches(matches_csv_path)
        self.player_results = self._index_by_player()
        self.tournament_shorthands = self._generate_tournament_shorthands()

    def _load_matches(self, csv_path: str) -> List[MatchResult]:
        """Load, normalize, and rate matches from CSV in chronological order."""
        raw_matches = []
        with open(csv_path, "r", newline="") as f:
            reader = csv.DictReader(f)
            for row in reader:
                try:
                    match_date = datetime.datetime.strptime(row["Date"], "%Y-%m-%d")
                    tournament = row["Tournament"].strip()
                    winner = int(str(row["Winner"]).strip())
                    if winner not in (1, 2):
                        raise ValueError("Winner must be 1 or 2")

                    player1_name, player1_company = self._normalize_match_player(row["Player 1"])
                    player2_name, player2_company = self._normalize_match_player(row["Player 2"])

                    match_format = "1v1 Rookies" if "rookie" in tournament.lower() else "1v1"
                    raw_matches.append(
                        {
                            "date": match_date,
                            "tournament": tournament,
                            "winner": winner,
                            "format": match_format,
                            "player1_name": player1_name,
                            "player1_company": player1_company,
                            "player2_name": player2_name,
                            "player2_company": player2_company,
                        }
                    )
                except (ValueError, KeyError) as exc:
                    print(f"Warning: Skipping invalid row: {row}. Error: {exc}")

        tournament_indices: Dict[str, int] = {}
        tournament_names: Dict[int, str] = {}  # Map index back to name for decay snapshots
        player_view_results: List[MatchResult] = []
        
        
        # First pass: count total matches per player per tournament
        player_tournament_match_counts: Dict[tuple, Dict[int, int]] = {}  # (player_name, company) -> {tournament_index -> count}
        player_tournament_match_indices: Dict[tuple, Dict[int, int]] = {}  # (player_name, company) -> {tournament_index -> current_match_num}
        
        for match in raw_matches:
            tournament_index = tournament_indices.setdefault(match["tournament"], len(tournament_indices))
            tournament_names[tournament_index] = match["tournament"]
            
            for player_info in [(match["player1_name"], match["player1_company"]), (match["player2_name"], match["player2_company"])]:
                if player_info not in player_tournament_match_counts:
                    player_tournament_match_counts[player_info] = {}
                    player_tournament_match_indices[player_info] = {}
                
                if tournament_index not in player_tournament_match_counts[player_info]:
                    player_tournament_match_counts[player_info][tournament_index] = 0
                    player_tournament_match_indices[player_info][tournament_index] = 0
                
                player_tournament_match_counts[player_info][tournament_index] += 1
        
        # Reset indices for second pass
        for player_info in player_tournament_match_indices:
            for tournament_index in player_tournament_match_indices[player_info]:
                player_tournament_match_indices[player_info][tournament_index] = 0
        
        for processing_index, match in enumerate(raw_matches):
            tournament_index = tournament_indices.setdefault(match["tournament"], len(tournament_indices))
            tournament_names[tournament_index] = match["tournament"]
            
            key1 = (match["player1_name"], match["player1_company"])
            key2 = (match["player2_name"], match["player2_company"])
            state1 = self.players.setdefault(key1, PlayerState(rating=Player()))
            state2 = self.players.setdefault(key2, PlayerState(rating=Player()))

            # Increment match indices for this tournament
            player_tournament_match_indices[key1][tournament_index] += 1
            player_tournament_match_indices[key2][tournament_index] += 1
            
            # Calculate inverse-diminishing weights for each player
            player1_match_num = player_tournament_match_indices[key1][tournament_index]
            player1_total_matches = player_tournament_match_counts[key1][tournament_index]
            player1_weight = self._calculate_match_weight(player1_match_num, player1_total_matches)
            
            player2_match_num = player_tournament_match_indices[key2][tournament_index]
            player2_total_matches = player_tournament_match_counts[key2][tournament_index]
            player2_weight = self._calculate_match_weight(player2_match_num, player2_total_matches)
            
            # Apply dynamic rookie bracket scaling if this is a rookie tournament
            is_rookie_bracket = 'rookie' in match['tournament'].lower()
            if is_rookie_bracket:
                # Get current ratings for scaling
                player1_scale = self._calculate_rookie_scale(state1.rating.rating, state1.rating.rd, player1_won)
                player2_scale = self._calculate_rookie_scale(state2.rating.rating, state2.rating.rd, not player1_won)
                player1_weight *= player1_scale
                player2_weight *= player2_scale
            
            # Apply decay and create snapshots if decay occurred
            decay_steps1 = self._apply_time_decay(state1, match["date"], tournament_index)
            decay_steps2 = self._apply_time_decay(state2, match["date"], tournament_index)
            
            # Generate decay snapshots for each missed tournament
            if decay_steps1:
                for step_idx, step in enumerate(decay_steps1):
                    player_view_results.append(
                        MatchResult(
                            company=match["player1_company"],
                            player_name=match["player1_name"],
                            opponent_name="",
                            opponent_company="",
                            won=False,
                            date=match["date"],
                            tournament="",  # Will be filled in later
                            format="1v1",
                            pre_rating=state1.rating.rating,
                            post_rating=state1.rating.rating,
                            pre_rd=step['pre_rd'],
                            post_rd=step['post_rd'],
                            pre_volatility=state1.rating.vol,
                            post_volatility=state1.rating.vol,
                            processing_index=processing_index - 0.5 - (len(decay_steps1) - step_idx) * 0.01,  # Sort before actual match
                            tournament_index=step['missed_index'],
                            is_decay_snapshot=True,
                        )
                    )
            
            if decay_steps2:
                for step_idx, step in enumerate(decay_steps2):
                    player_view_results.append(
                        MatchResult(
                            company=match["player2_company"],
                            player_name=match["player2_name"],
                            opponent_name="",
                            opponent_company="",
                            won=False,
                            date=match["date"],
                            tournament="",  # Will be filled in later
                            format="1v1",
                            pre_rating=state2.rating.rating,
                            post_rating=state2.rating.rating,
                            pre_rd=step['pre_rd'],
                            post_rd=step['post_rd'],
                            pre_volatility=state2.rating.vol,
                            post_volatility=state2.rating.vol,
                            processing_index=processing_index - 0.5 - (len(decay_steps2) - step_idx) * 0.01,  # Sort before actual match
                            tournament_index=step['missed_index'],
                            is_decay_snapshot=True,
                        )
                    )

            player1_rating = state1.rating.rating
            player1_rd = state1.rating.rd
            player1_vol = state1.rating.vol
            player2_rating = state2.rating.rating
            player2_rd = state2.rating.rd
            player2_vol = state2.rating.vol
            player1_pre_conservative = player1_rating - (2 * player1_rd)
            player2_pre_conservative = player2_rating - (2 * player2_rd)

            if match["winner"] == 1:
                state1.rating.update_player([player2_rating], [player2_rd], [1.0])
                state2.rating.update_player([player1_rating], [player1_rd], [0.0])
                player1_won = True
            else:
                state1.rating.update_player([player2_rating], [player2_rd], [0.0])
                state2.rating.update_player([player1_rating], [player1_rd], [1.0])
                player1_won = False
            
            # Apply match weight by interpolating between pre-update and post-update ratings
            # Weight of 1.0 = full change, weight of 0.5 = half change, etc.
            player1_new_rating = state1.rating.rating
            player1_new_rd = state1.rating.rd
            state1.rating.rating = player1_rating + (player1_new_rating - player1_rating) * player1_weight
            state1.rating.rd = player1_rd + (player1_new_rd - player1_rd) * player1_weight
            
            player2_new_rating = state2.rating.rating
            player2_new_rd = state2.rating.rd
            state2.rating.rating = player2_rating + (player2_new_rating - player2_rating) * player2_weight
            state2.rating.rd = player2_rd + (player2_new_rd - player2_rd) * player2_weight
            state1.last_played_date = match["date"]
            state2.last_played_date = match["date"]
            state1.last_tournament_index = tournament_index
            state2.last_tournament_index = tournament_index
            state1.match_count += 1
            state2.match_count += 1
            state1.wins += int(player1_won)
            state1.losses += int(not player1_won)
            state2.wins += int(not player1_won)
            state2.losses += int(player1_won)
            if match["format"] == "1v1 Rookies":
                state1.rookie_match_count += 1
                state2.rookie_match_count += 1
            else:
                state1.main_match_count += 1
                state2.main_match_count += 1

            player1_post_conservative = state1.rating.rating - (2 * state1.rating.rd)
            player2_post_conservative = state2.rating.rating - (2 * state2.rating.rd)

            player_view_results.extend(
                [
                    MatchResult(
                        company=match["player1_company"],
                        player_name=match["player1_name"],
                        opponent_name=match["player2_name"],
                        opponent_company=match["player2_company"],
                        won=player1_won,
                        date=match["date"],
                        tournament=match["tournament"],
                        format=match["format"],
                        pre_rating=player1_rating,
                        post_rating=state1.rating.rating,
                        pre_rd=player1_rd,
                        post_rd=state1.rating.rd,
                        pre_volatility=player1_vol,
                        post_volatility=state1.rating.vol,
                        processing_index=processing_index,
                        tournament_index=tournament_index,
                        rating_change_weight=player1_weight,
                    ),
                    MatchResult(
                        company=match["player2_company"],
                        player_name=match["player2_name"],
                        opponent_name=match["player1_name"],
                        opponent_company=match["player1_company"],
                        won=not player1_won,
                        date=match["date"],
                        tournament=match["tournament"],
                        format=match["format"],
                        pre_rating=player2_rating,
                        post_rating=state2.rating.rating,
                        pre_rd=player2_rd,
                        post_rd=state2.rating.rd,
                        pre_volatility=player2_vol,
                        post_volatility=state2.rating.vol,
                        processing_index=processing_index,
                        tournament_index=tournament_index,
                        rating_change_weight=player2_weight,
                    ),
                ]
            )

        # Fill in tournament names for decay snapshots using the tournament_names map
        for result in player_view_results:
            if result.is_decay_snapshot and not result.tournament:
                result.tournament = tournament_names.get(result.tournament_index, f"Missed Tournament {result.tournament_index}")

        # Add decay snapshots for players who stopped playing (up to most recent tournament)
        if tournament_indices:
            max_tournament_index = max(tournament_indices.values())
            
            for player_key, state in self.players.items():
                if state.last_tournament_index is not None and state.last_tournament_index < max_tournament_index:
                    # This player hasn't played since tournament X, apply decay up to current
                    missed_count = max_tournament_index - state.last_tournament_index
                    
                    # Simulate decay incrementally
                    current_rd = state.rating.rd
                    for i in range(missed_count):
                        missed_idx = state.last_tournament_index + 1 + i
                        pre_step_rd = current_rd
                        
                        # Apply decay
                        decay_multiplier = MISSED_TOURNAMENT_RD_SCALE * (1 + i * 0.2)
                        current_rd_scaled = current_rd / 173.7178
                        decayed_rd = math.sqrt(current_rd_scaled ** 2 + (decay_multiplier * (state.rating.vol ** 2))) * 173.7178
                        current_rd = min(decayed_rd, 350.0)
                        
                        # Create decay snapshot
                        player_view_results.append(
                            MatchResult(
                                company=player_key[1],
                                player_name=player_key[0],
                                opponent_name="",
                                opponent_company="",
                                won=False,
                                date=raw_matches[-1]["date"] if raw_matches else datetime.datetime.now(),
                                tournament=tournament_names.get(missed_idx, f"Missed Tournament {missed_idx}"),
                                format="1v1",
                                pre_rating=state.rating.rating,
                                post_rating=state.rating.rating,
                                pre_rd=pre_step_rd,
                                post_rd=current_rd,
                                pre_volatility=state.rating.vol,
                                post_volatility=state.rating.vol,
                                processing_index=len(raw_matches) + missed_idx + 0.1,
                                tournament_index=missed_idx,
                                is_decay_snapshot=True,
                            )
                        )

        return player_view_results

    def _normalize_match_player(self, raw_player: str) -> Tuple[str, str]:
        """Normalize a player cell from matches.csv using registry first, then legacy cleaning plus stored aliases."""
        registry = get_player_registry()
        registry_player = registry.resolve(raw_player)
        if registry_player:
            return registry_player.canonical_name, registry_player.company
        name, company_code = clean_player_entry(raw_player)
        company_name = COMPANY_CODES.get(company_code, "N/A") if company_code else "N/A"
        alias_target = self.stored_player_aliases.get(_stored_alias_key(name, company_name))
        if alias_target:
            return alias_target['name'], alias_target['company']
        return name, company_name

    def _calculate_league(self, conservative_rating: float, all_conservative_ratings: List[float]) -> str:
        """Assign a league based on conservative rating quartile, rounded to 50CR intervals.
        
        Args:
            conservative_rating: The player's conservative rating
            all_conservative_ratings: Sorted list of all players' conservative ratings
        Returns:
            League name string
        """
        if not all_conservative_ratings:
            return "Smashclub Interns"
        
        # Calculate quartiles
        sorted_ratings = sorted(all_conservative_ratings, reverse=True)
        n = len(sorted_ratings)
        
        # Determine quartile with icon
        if conservative_rating >= sorted_ratings[n // 4]:
            # Top quartile
            return "🏆 Champions"
        elif conservative_rating >= sorted_ratings[n // 2]:
            # Second quartile
            return "💼 Smashclub Full-Timers"
        elif conservative_rating >= sorted_ratings[3 * n // 4]:
            # Third quartile
            return "🎓 Smashclub Grads"
        else:
            # Bottom quartile
            return "👶 Smashclub Interns"
    
    def _calculate_rookie_scale(self, player_rating: float, player_rd: float, won: bool) -> float:
        """Calculate rookie bracket scaling based on player rating thresholds.
        
        Higher-rated players get less gain from wins and more loss from losses,
        encouraging them to graduate to main bracket.
        
        Args:
            player_rating: Player's current rating (not conservative)
            player_rd: Player's current rating deviation
            won: Whether the player won the match
        Returns:
            Scale multiplier for rookie bracket
        """
        # Use raw rating for thresholds
        if player_rating >= ROOKIE_OVER_PENALTY_THRESHOLD:
            # Over-penalty tier (1650+)
            return 0.4 if won else 1.25
        elif player_rating >= ROOKIE_FULL_PENALTY_THRESHOLD:
            # Full penalty tier (1550-1650)
            return 0.25 if won else 1.0
        elif player_rating >= ROOKIE_PARTIAL_PENALTY_THRESHOLD:
            # Partial penalty tier (1400-1550)
            return 0.375 if won else 0.75
        else:
            # Base tier (< 1400)
            return ROOKIE_BRACKET_BASE_SCALE
    
    def _calculate_match_weight(self, match_num: int, total_matches: int) -> float:
        """Calculate inverse-diminishing weight for a match within a tournament.
        
        Later matches get full weight, earlier matches get reduced weight.
        Args:
            match_num: 1-indexed position of this match in the player's tournament (1 = first match)
            total_matches: Total number of matches this player has in the tournament
        Returns:
            Weight between 0 and 1
        """
        if total_matches <= 0:
            return 1.0
        
        # Inverse-diminishing: (match_num / total_matches) ^ exponent
        # First match gets lowest weight, last match gets 1.0
        return (match_num / total_matches) ** INVERSE_DIMINISHING_EXPONENT
    
    def _apply_time_decay(self, state: PlayerState, match_date: datetime.datetime, tournament_index: int) -> Optional[list]:
        """Increase RD based on missed tournaments, return list of decay steps if applied."""
        if state.last_tournament_index is None:
            return None

        missed_tournaments = max(tournament_index - state.last_tournament_index - 1, 0)
        if missed_tournaments <= 0:
            return None

        # Apply decay incrementally for each missed tournament
        decay_steps = []
        current_rd = state.rating.rd
        
        for i in range(missed_tournaments):
            pre_step_rd = current_rd
            # Scale decay by position in sequence (later misses hurt more)
            decay_multiplier = MISSED_TOURNAMENT_RD_SCALE * (1 + i * 0.2)  # 20% increase per consecutive miss
            
            current_rd_scaled = current_rd / 173.7178
            decayed_rd = math.sqrt(current_rd_scaled ** 2 + (decay_multiplier * (state.rating.vol ** 2))) * 173.7178
            current_rd = min(decayed_rd, 350.0)
            
            decay_steps.append({
                'pre_rd': pre_step_rd,
                'post_rd': current_rd,
                'missed_index': state.last_tournament_index + 1 + i,
            })
        
        # Apply final decayed RD to state
        state.rating.rd = current_rd
        return decay_steps

    def _decayed_rating_as_of(self, state: PlayerState, as_of: Optional[datetime.datetime] = None) -> Player:
        """Return a copy of the player's current rating; tournament-based decay is applied during processing."""
        return Player(rating=state.rating.rating, rd=state.rating.rd, vol=state.rating.vol)

    def _representative_identity(self, results: List[MatchResult]) -> Optional[Tuple[str, str]]:
        """Choose the best identity key to represent a matched player history."""
        if not results:
            return None

        grouped = defaultdict(list)
        for result in results:
            grouped[(result.player_name, result.company)].append(result)

        return max(
            grouped.items(),
            key=lambda item: (
                len(item[1]),
                max(result.date for result in item[1]),
                item[0][0].lower(),
            ),
        )[0]

    def _count_main_exposed_opponents(self, results: List[MatchResult]) -> int:
        """Count unique opponents who have played at least one main-bracket set."""
        opponent_keys = {
            (result.opponent_name, result.opponent_company)
            for result in results
            if result.opponent_name and result.opponent_company
        }
        return sum(
            1
            for opponent_key in opponent_keys
            if opponent_key in self.players and self.players[opponent_key].main_match_count > 0
        )

    def _group_results(self) -> Dict[Tuple[str, str], List[MatchResult]]:
        grouped = defaultdict(list)
        for result in self.results:
            grouped[(result.player_name, result.company)].append(result)
        return grouped

    def _exact_match_keys(self, grouped: Dict[Tuple[str, str], List[MatchResult]], normalized_name: str, normalized_company: Optional[str]) -> List[Tuple[str, str]]:
        return [
            key for key in grouped
            if key[0].lower() == normalized_name.lower()
            and (
                not normalized_company
                or key[1].lower() == normalized_company.lower()
                or key[1] == 'N/A'
            )
        ]

    def _glicko_query_candidates(self, grouped: Dict[Tuple[str, str], List[MatchResult]], normalized_name: str, normalized_company: Optional[str]) -> List[Tuple[float, Tuple[str, str]]]:
        query_parts = normalized_name.lower().split()
        candidates: List[Tuple[float, Tuple[str, str]]] = []
        for key in grouped:
            candidate_name, candidate_company = key
            if normalized_company and candidate_company not in {'N/A', normalized_company}:
                continue
            candidate_parts = candidate_name.lower().split()
            if not query_parts or not candidate_parts:
                continue
            score = 0.0
            if len(query_parts) >= 2 and len(candidate_parts) == 1 and query_parts[0] == candidate_parts[0]:
                score = 0.84
            elif len(query_parts) >= 2 and len(candidate_parts) >= 2 and query_parts[0] == candidate_parts[0]:
                if query_parts[-1] == candidate_parts[-1]:
                    score = 0.98
                elif len(candidate_parts[-1]) == 1 and query_parts[-1].startswith(candidate_parts[-1]):
                    score = 0.92
                elif len(query_parts[-1]) == 1 and candidate_parts[-1].startswith(query_parts[-1]):
                    score = 0.92
            if score > 0:
                candidates.append((score, key))
        candidates.sort(key=lambda item: (-item[0], item[1][0].lower(), item[1][1].lower()))
        return candidates

    def review_player_alias_candidates(self, player_inputs: List[PlayerInput], interactive: bool = True, verbose: bool = False) -> None:
        grouped = self._group_results()
        aliases_updated = False
        registry = get_player_registry()
        for player in player_inputs:
            registry_player = registry.resolve(player.name, player.company)
            normalized_name = registry_player.canonical_name if registry_player else player.normalize_name()
            normalized_company = registry_player.company if registry_player else player.normalize_company()
            if self._exact_match_keys(grouped, normalized_name, normalized_company):
                continue
            alias_key = _query_alias_key(normalized_name, normalized_company)
            if alias_key in self.player_query_aliases:
                continue
            candidates = self._glicko_query_candidates(grouped, normalized_name, normalized_company)
            if not candidates:
                continue
            if verbose:
                nearby = [key[0] for _, key in candidates[:5]]
                print(f"[Glicko] no exact canonical match for '{player.name}'. Nearby stored names: {nearby}")
            if not interactive:
                continue
            print(f"\n⚠ No exact Glicko match for '{player.name}' ({normalized_company or 'Unknown company'})")
            print('   Choose a canonical stored name to use for this player in future runs:')
            for index, (score, key) in enumerate(candidates[:5], start=1):
                print(f"   {index}. {key[0]} [{key[1]}] score={score:.2f}")
            print('   0. Keep separate / no alias')
            response = input('   Choice: ').strip()
            if response in {'', '0', 'n', 'no'}:
                continue
            if response.isdigit():
                choice = int(response)
                if 1 <= choice <= min(5, len(candidates)):
                    chosen_name, chosen_company = candidates[choice - 1][1]
                    self.player_query_aliases[alias_key] = {'name': chosen_name, 'company': chosen_company}
                    aliases_updated = True
                    if verbose:
                        print(f"[Glicko] saved query alias '{player.name}' -> '{chosen_name}'")
        if aliases_updated:
            _write_glicko_player_aliases(self.player_query_aliases)

    def _resolve_query_alias_target(self, player: PlayerInput) -> Optional[Dict[str, str]]:
        registry_player = get_player_registry().resolve(player.name, player.company)
        normalized_name = registry_player.canonical_name if registry_player else player.normalize_name()
        normalized_company = registry_player.company if registry_player else player.normalize_company()
        alias_key = _query_alias_key(normalized_name, normalized_company)
        return self.player_query_aliases.get(alias_key)

    def find_player_results(self, player: PlayerInput, verbose: bool = False, interactive: bool = True) -> List[MatchResult]:
        """Find player history by exact canonical name or explicit saved query alias only."""
        registry_player = get_player_registry().resolve(player.name, player.company)
        normalized_name = registry_player.canonical_name if registry_player else player.normalize_name()
        normalized_company = registry_player.company if registry_player else player.normalize_company()
        grouped = self._group_results()

        exact_matches = self._exact_match_keys(grouped, normalized_name, normalized_company)
        if exact_matches:
            merged = []
            for key in exact_matches:
                merged.extend(grouped[key])
            return merged

        alias_target = self._resolve_query_alias_target(player)
        if alias_target:
            target_key = (alias_target['name'], alias_target['company'])
            return grouped.get(target_key, [])

        if verbose:
            candidate_names = [key[0] for _, key in self._glicko_query_candidates(grouped, normalized_name, normalized_company)[:5]]
            if candidate_names:
                print(f"[Glicko] no exact canonical match for '{player.name}'. Nearby stored names: {candidate_names}")
            print(f"[players.yaml] {get_player_registry().suggest_update_message(player.name, normalized_company)}")

        return []

    def calculate_player_score(self, results: List[MatchResult], use_time_decay: bool = True) -> Dict[str, float]:
        """Return output-compatible score data using conservative Glicko rating."""
        if not results:
            return {
                "system": "glicko2",
                "1v1_score": float("-inf"),
                "2v2_score": float("inf"),
                "best_placement": float("inf"),
                "most_recent_placement": float("inf"),
                "num_tournaments": 0,
                "most_recent_tournament_date": None,
                "peak_bonus": 0.0,
                "rating": 1500.0,
                "rd": 350.0,
                "volatility": 0.06,
                "match_count": 0,
                "wins": 0,
                "losses": 0,
                "conservative_rating": float("-inf"),
            }

        identity = self._representative_identity(results)
        if identity is None:
            return self.calculate_player_score([])

        state = self.players[identity]
        rating = self._decayed_rating_as_of(state) if use_time_decay else state.rating

        rookie_ratio = (state.rookie_match_count / state.match_count) if state.match_count else 0.0
        main_experience_factor = min(state.main_match_count, 5) / 5 if state.match_count else 0.0
        bridge_opponent_count = self._count_main_exposed_opponents(results)
        bridge_factor = min(bridge_opponent_count, 5) / 5 if state.match_count else 0.0
        isolation_factor = rookie_ratio * (1.0 - max(main_experience_factor, bridge_factor))
        rookie_only_island = state.main_match_count == 0 and bridge_opponent_count == 0 and state.rookie_match_count >= 3

        rookie_rd_multiplier = 1.0 + (0.9 * isolation_factor) + (0.5 if rookie_only_island else 0.0)
        effective_rd = min(350.0, rating.rd * rookie_rd_multiplier)

        rating_anchor_factor = max(0.25, 1.0 - (0.65 * isolation_factor) - (0.2 if rookie_only_island else 0.0))
        tournaments = len({result.tournament for result in results})
        unique_opponents = len({(result.opponent_name, result.opponent_company) for result in results})
        tournament_factor = min(tournaments, 3) / 3
        opponent_factor = min(unique_opponents, 8) / 8
        match_factor = min(state.match_count, 10) / 10
        base_sample_confidence = max(0.35, min(1.0, (0.45 * tournament_factor) + (0.35 * opponent_factor) + (0.20 * match_factor)))
        overlap_confidence = max(main_experience_factor, bridge_factor, 0.2)
        if rookie_ratio > 0:
            sample_confidence = max(0.2, min(base_sample_confidence, overlap_confidence + (0.25 * (1.0 - rookie_ratio))))
        else:
            sample_confidence = base_sample_confidence

        effective_rating = 1500.0 + ((rating.rating - 1500.0) * rating_anchor_factor * sample_confidence)
        conservative_rating = effective_rating - (2 * effective_rd)
        most_recent_date = max(result.date for result in results)

        return {
            "system": "glicko2",
            "1v1_score": conservative_rating,
            "2v2_score": float("inf"),
            "best_placement": float("inf"),
            "most_recent_placement": float("inf"),
            "num_tournaments": tournaments,
            "most_recent_tournament_date": most_recent_date,
            "peak_bonus": 0.0,
            "rating": rating.rating,
            "effective_rating": effective_rating,
            "rating_adjustment": effective_rating - rating.rating,
            "rd": effective_rd,
            "raw_rd": rating.rd,
            "volatility": rating.vol,
            "match_count": state.match_count,
            "wins": state.wins,
            "losses": state.losses,
            "main_match_count": state.main_match_count,
            "rookie_match_count": state.rookie_match_count,
            "rookie_ratio": rookie_ratio,
            "bridge_opponent_count": bridge_opponent_count,
            "isolation_factor": isolation_factor,
            "sample_confidence": sample_confidence,
            "unique_opponent_count": unique_opponents,
            "conservative_rating": conservative_rating,
        }

    def review_historical_identity_candidates(self, interactive: bool = True, verbose: bool = False) -> bool:
        grouped = self._group_results()
        identities = sorted(grouped.keys(), key=lambda item: (item[1].lower(), item[0].lower()))
        updates_made = False
        seen_pairs = set()

        for name, company in identities:
            name_parts = name.lower().split()
            for other_name, other_company in identities:
                if (name, company) == (other_name, other_company) or company != other_company:
                    continue
                pair_id = tuple(sorted([(name, company), (other_name, other_company)]))
                if pair_id in seen_pairs:
                    continue
                seen_pairs.add(pair_id)

                score = 0.0
                other_parts = other_name.lower().split()
                if len(name_parts) == 1 and len(other_parts) >= 2 and name_parts[0] == other_parts[0]:
                    score = 0.84
                elif len(other_parts) == 1 and len(name_parts) >= 2 and other_parts[0] == name_parts[0]:
                    score = 0.84
                elif len(name_parts) >= 2 and len(other_parts) >= 2 and name_parts[0] == other_parts[0]:
                    if name_parts[-1] == other_parts[-1]:
                        score = 0.98
                    elif len(name_parts[-1]) == 1 and other_parts[-1].startswith(name_parts[-1]):
                        score = 0.92
                    elif len(other_parts[-1]) == 1 and name_parts[-1].startswith(other_parts[-1]):
                        score = 0.92
                if score < 0.84:
                    continue

                if verbose:
                    print(f"[Glicko history] possible duplicate stored identities: {name} [{company}] vs {other_name} [{other_company}] score={score:.2f}")
                if not interactive:
                    continue

                preferred_name, preferred_company = max([(name, company), (other_name, other_company)], key=lambda item: (len(item[0].split()), len(item[0]), item[0]))
                print(f"\n⚠ Possible duplicate stored Glicko identities:")
                print(f"   1. {name} [{company}]")
                print(f"   2. {other_name} [{other_company}]")
                print(f"   0. Keep separate")
                response = input(f"   Choose canonical identity to keep (default {preferred_name}): ").strip()
                if response in {'', '1', '2'}:
                    if response == '1':
                        chosen = (name, company)
                        other = (other_name, other_company)
                    elif response == '2':
                        chosen = (other_name, other_company)
                        other = (name, company)
                    else:
                        chosen = (preferred_name, preferred_company)
                        other = (other_name, other_company) if (preferred_name, preferred_company) == (name, company) else (name, company)
                else:
                    continue
                self.stored_player_aliases[_stored_alias_key(other[0], other[1])] = {'name': chosen[0], 'company': chosen[1]}
                updates_made = True
                if verbose:
                    print(f"[Glicko history] saved stored alias {other} -> {chosen}")

        if updates_made:
            _write_glicko_stored_aliases(self.stored_player_aliases)
        return updates_made

    def get_all_players_from_history(self) -> List[PlayerInput]:
        """Return all unique players found in historical match data."""
        unique_players = {}
        for result in self.results:
            key = (result.player_name.strip().lower(), result.company.strip())
            if key not in unique_players:
                company_code = None
                for code, company_name in COMPANY_CODES.items():
                    if company_name == result.company:
                        company_code = code
                        break
                unique_players[key] = PlayerInput(result.player_name, company_code or result.company)
        return sorted(unique_players.values(), key=lambda player: ((player.company or '').lower(), player.name.lower()))

    def seed_players(
        self,
        player_inputs: List[PlayerInput],
        verbose: bool = False,
        interactive: bool = True,
        use_time_decay: bool = True,
    ) -> List[Dict]:
        """Seed players by conservative Glicko score while keeping output compatibility."""
        seeded_players: List[Dict] = []

        for player in player_inputs:
            alias_target = self._resolve_query_alias_target(player)
            results = self.find_player_results(player, verbose=verbose, interactive=interactive)
            score_info = self.calculate_player_score(results, use_time_decay=use_time_decay)

            if player.company:
                matched_company = player.normalize_company()
            elif results:
                companies = [result.company for result in results if result.company != "N/A"]
                matched_company = Counter(companies).most_common(1)[0][0] if companies else results[0].company
            else:
                matched_company = None

            seeded_players.append(
                {
                    "name": player.name,
                    "company": matched_company or "Unknown",
                    "results": results,
                    "score": score_info,
                    "has_history": bool(results),
                    "score_source": "glicko2",
                    "query_alias_used": alias_target,
                    "h2h_adjustment": 0.0,
                    "h2h_details": [],
                }
            )

        seeded_players.sort(
            key=lambda player: (
                0 if player["has_history"] else 1,
                -(player["score"]["conservative_rating"] if player["has_history"] else float("-inf")),
                -player["score"]["rating"],
                player["score"]["rd"],
                player["name"].lower(),
            )
        )

        for seed, player in enumerate(seeded_players, start=1):
            player["seed"] = seed

        return seeded_players

    def export_rankings(self, seeded_players: List[Dict], output_path: str) -> str:
        os.makedirs(os.path.dirname(output_path) or '.', exist_ok=True)
        export_rows = []
        
        # Calculate all conservative ratings for quartile calculation
        all_conservative_ratings = []
        for player in seeded_players:
            score = player['score']
            rating = score.get('rating')
            rd = score.get('rd')
            if rating is not None and rd is not None:
                conservative_rating = rating - 2 * rd
                all_conservative_ratings.append(conservative_rating)
        
        for player in seeded_players:
            score = player['score'].copy()
            # Replace infinity values with null and serialize datetime for valid JSON
            for key, value in score.items():
                if isinstance(value, float) and (math.isinf(value) or math.isnan(value)):
                    score[key] = None
                elif isinstance(value, datetime.datetime):
                    score[key] = value.isoformat()
            
            # Calculate league (only for players with history)
            league = None
            if player['has_history']:
                rating = score.get('rating')
                rd = score.get('rd')
                if rating is not None and rd is not None:
                    conservative_rating = rating - 2 * rd
                    league = self._calculate_league(conservative_rating, all_conservative_ratings)
            
            export_rows.append(
                {
                    'seed': player['seed'],
                    'name': player['name'],
                    'company': player['company'],
                    'has_history': player['has_history'],
                    'query_alias_used': player.get('query_alias_used'),
                    'league': league,
                    'score': score,
                }
            )
        with open(output_path, 'w') as f:
            json.dump(export_rows, f, indent=2)
        return output_path

    def export_match_history(self, output_path: str) -> str:
        os.makedirs(os.path.dirname(output_path) or '.', exist_ok=True)
        registry = get_player_registry()
        unexpected_companies = set()
        
        with open(output_path, 'w', newline='') as f:
            writer = csv.DictWriter(
                f,
                fieldnames=[
                    'processing_index', 'tournament_index', 'date', 'tournament', 'format', 'player_name', 'company',
                    'opponent_name', 'opponent_company', 'won', 'pre_rating', 'post_rating', 'pre_rd', 'post_rd',
                    'pre_volatility', 'post_volatility', 'is_decay_snapshot', 'rating_change_weight'
                ],
            )
            writer.writeheader()
            for result in sorted(self.results, key=lambda item: (item.processing_index, item.player_name, item.opponent_name)):
                # Normalize company using registry's past_companies
                player_reg = registry.resolve(result.player_name, result.company)
                opponent_reg = registry.resolve(result.opponent_name, result.opponent_company)
                
                normalized_company = result.company
                normalized_opponent_company = result.opponent_company
                
                if player_reg:
                    resolved_company = player_reg.resolve_company(result.company)
                    if resolved_company != result.company and result.company.lower() not in [pc.lower() for pc in player_reg.past_companies]:
                        unexpected_companies.add((result.player_name, result.company, player_reg.company))
                    normalized_company = resolved_company
                
                if opponent_reg:
                    resolved_opponent_company = opponent_reg.resolve_company(result.opponent_company)
                    if resolved_opponent_company != result.opponent_company and result.opponent_company.lower() not in [pc.lower() for pc in opponent_reg.past_companies]:
                        unexpected_companies.add((result.opponent_name, result.opponent_company, opponent_reg.company))
                    normalized_opponent_company = resolved_opponent_company
                
                writer.writerow(
                    {
                        'processing_index': result.processing_index,
                        'tournament_index': result.tournament_index,
                        'date': result.date.date().isoformat(),
                        'tournament': result.tournament,
                        'format': result.format,
                        'player_name': result.player_name,
                        'company': normalized_company,
                        'opponent_name': result.opponent_name,
                        'opponent_company': normalized_opponent_company,
                        'won': int(result.won) if not result.is_decay_snapshot else 0,
                        'pre_rating': f'{result.pre_rating:.6f}',
                        'post_rating': f'{result.post_rating:.6f}',
                        'pre_rd': f'{result.pre_rd:.6f}',
                        'post_rd': f'{result.post_rd:.6f}',
                        'pre_volatility': f'{result.pre_volatility:.6f}',
                        'post_volatility': f'{result.post_volatility:.6f}',
                        'is_decay_snapshot': int(result.is_decay_snapshot),
                        'rating_change_weight': f'{result.rating_change_weight:.3f}',
                    }
                )
        
        # Warn about unexpected companies
        if unexpected_companies:
            print("\n⚠️  Players appeared under unexpected companies:")
            for player_name, observed_company, canonical_company in sorted(unexpected_companies):
                print(f"   {player_name}: '{observed_company}' (expected: '{canonical_company}')")
                print(f"      Consider adding '{observed_company}' to past_companies in players.yaml")
        
        return output_path

    def export_default_outputs(self, seeded_players: List[Dict]) -> Dict[str, str]:
        os.makedirs(GLICKO_EXPORT_DIR, exist_ok=True)
        return {
            'rankings': self.export_rankings(seeded_players, os.path.join(GLICKO_EXPORT_DIR, 'glicko_rankings.json')),
            'history': self.export_match_history(os.path.join(GLICKO_EXPORT_DIR, 'glicko_match_history.csv')),
        }
