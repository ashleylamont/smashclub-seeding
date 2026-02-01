"""
Player Seeding Algorithm for SSBU Tournaments

This module implements a seeding algorithm based on historical tournament performance.
It prioritizes 1v1 results and uses 2v2 results for tiebreaking.
"""

import csv
import re
from dataclasses import dataclass
from typing import List, Dict, Optional, Tuple
from collections import defaultdict
import datetime
from difflib import SequenceMatcher
import hashlib

# Centralized company definitions
COMPANY_CODES = {
    'ATL': 'Atlassian',
    'CAN': 'Canva',
    'OPT': 'Optiver',
    'GOOG': 'Google',
    'WOW': 'Woolworths',
    'REL': 'Relevance AI',
    'SUS': 'Susquehanna',
    'AMD': 'AMD',
    'LYR': 'Lyra',
    'DEC': 'Deckard',
    'ANA': 'Anaplan',
}

# Aliases for company names (maps various inputs to standard codes)
COMPANY_ALIASES = {
    'Atlas': 'ATL',
    'Atlassian': 'ATL',
    'Google': 'GOOG',
    'Canva': 'CAN',
    'Optiver': 'OPT',
    'Woolworths': 'WOW',
    'Relevance AI': 'REL',
    'Relevance': 'REL',
    'Susquehanna': 'SUS',
    'AMD': 'AMD',
    'Lyra': 'LYR',
    'Deckard': 'DEC',
    'Anaplan': 'ANA',
}


@dataclass
class TournamentResult:
    """Represents a single tournament result for a player."""
    company: str
    player_name: str
    placement: int
    date: datetime.datetime
    format: str  # '1v1', '2v2', or '1v1 Rookies'
    tournament: str

    @property
    def is_1v1(self) -> bool:
        return self.format == '1v1'

    @property
    def is_1v1_rookies(self) -> bool:
        return self.format == '1v1 Rookies'

    @property
    def is_2v2(self) -> bool:
        return self.format == '2v2'


@dataclass
class PlayerInput:
    """Represents a player entry for the tournament."""
    name: str
    company: Optional[str] = None

    def normalize_name(self) -> str:
        """Remove 'deactivated' and extra whitespace from names."""
        name = self.name.lower().strip()
        name = name.replace('deactivated', '').strip()
        return name

    def normalize_company(self) -> Optional[str]:
        """Normalize company codes to full names."""
        if not self.company:
            return None

        company_upper = self.company.upper()
        return COMPANY_CODES.get(company_upper, self.company)


class SeedingCalculator:
    """Calculates player seeding based on historical results."""

    def __init__(self, results_csv_path: str):
        """Initialize with historical results from CSV."""
        self.results = self._load_results(results_csv_path)
        self._adjust_rookies_placements()
        self.player_results = self._index_by_player()
        self.tournament_shorthands = self._generate_tournament_shorthands()

    def _load_results(self, csv_path: str) -> List[TournamentResult]:
        """Load tournament results from CSV file."""
        results = []
        with open(csv_path, 'r') as f:
            reader = csv.DictReader(f)
            for row in reader:
                try:
                    date = datetime.datetime.strptime(row['Date'], '%Y-%m-%d')
                    result = TournamentResult(
                        company=row['Company'].strip(),
                        player_name=row['Player name'].strip(),
                        placement=int(row['Placement']),
                        date=date,
                        format=row['Format'].strip(),
                        tournament=row['Tournament'].strip()
                    )
                    results.append(result)
                except (ValueError, KeyError) as e:
                    print(f"Warning: Skipping invalid row: {row}. Error: {e}")
        return results

    def _generate_tournament_shorthands(self) -> Dict[str, str]:
        """
        Generate short codes for tournament names.
        Uses meaningful abbreviations or date-based codes.
        """
        tournament_names = set(r.tournament for r in self.results)
        shorthands = {}

        for tournament in tournament_names:
            # Create meaningful shorthand
            if 'titlesponsorbattlegrounds' in tournament.lower():
                shorthand = 'TSB'
            elif 'enterprisetransformation' in tournament.lower():
                shorthand = 'ETO'
            elif 'macroeconomic' in tournament.lower():
                shorthand = 'MM'
            elif 'frame data signals' in tournament.lower():
                shorthand = 'FDS'
            elif 'tech in place #1' in tournament.lower():
                shorthand = 'TIP1'
            elif 'tech in place #2' in tournament.lower():
                shorthand = 'TIP2'
            elif 'tech in place #3' in tournament.lower():
                shorthand = 'TIP3'
            elif 'tech in place 0' in tournament.lower():
                shorthand = 'TIP0'
            elif 'rookierumble' in tournament.lower():
                shorthand = 'RR'
            else:
                # Fallback: use first letters of words or hash
                words = re.findall(r'[A-Z][a-z]*|[a-z]+', tournament)
                if words:
                    shorthand = ''.join(w[0].upper() for w in words[:3])
                else:
                    # Use short hash as last resort
                    shorthand = hashlib.md5(tournament.encode()).hexdigest()[:4].upper()

            shorthands[tournament] = shorthand

        return shorthands

    def _index_by_player(self) -> Dict[str, List[TournamentResult]]:
        """Index results by normalized player name and company."""
        index = defaultdict(list)
        for result in self.results:
            # Create multiple keys for flexible matching
            name_normalized = result.player_name.lower().strip()
            company_normalized = result.company.strip()

            # Full name + company key
            full_key = f"{name_normalized}|{company_normalized}"
            index[full_key].append(result)

            # First name + company key (for eager first-name matching)
            # Only add if different from full name (avoid duplicates for single-name players)
            first_name = name_normalized.split()[0] if name_normalized else ""
            first_key = f"{first_name}|{company_normalized}"
            if first_key != full_key:
                index[first_key].append(result)

        return index

    def _adjust_rookies_placements(self) -> None:
        """
        Dynamically adjust Rookies placements using transitive performance comparisons.
        
        Instead of using a fixed multiplier, this method analyzes each rookie's performance
        against players who competed in both rookie and main brackets across tournaments,
        and uses those comparisons to estimate where the rookie would place in the main bracket.
        """
        # Build player histories for transitive comparisons
        player_histories = defaultdict(list)
        for result in self.results:
            if result.is_1v1 or result.is_1v1_rookies:
                player_histories[result.player_name].append({
                    'tournament': result.tournament,
                    'placement': result.placement,
                    'date': result.date,
                    'format': result.format,
                    'company': result.company
                })

        # Group tournaments by name
        tournament_max_placement = {}
        tournaments = {}
        for result in self.results:
            tournament = result.tournament
            if tournament not in tournaments:
                tournaments[tournament] = {'rookies': [], 'main': []}

            if result.is_1v1:
                tournament_max_placement[tournament] = max(
                    tournament_max_placement.get(tournament, 0),
                    result.placement
                )
                tournaments[tournament]['main'].append({
                    'player': result.player_name,
                    'placement': result.placement
                })
            elif result.is_1v1_rookies:
                tournaments[tournament]['rookies'].append({
                    'player': result.player_name,
                    'placement': result.placement,
                    'result_obj': result
                })

        # Build transitive comparisons for each rookie player
        for tournament, brackets in tournaments.items():
            if not brackets['rookies']:
                continue  # Skip if no rookies in this tournament

            max_main = tournament_max_placement.get(tournament, 0)

            # For rookies-only tournaments (no main bracket), estimate a reasonable adjustment
            # Use the number of rookies as a proxy for tournament size
            if max_main == 0:
                num_rookies = len(brackets['rookies'])
                # Assume rookies-only tournament is similar to a larger bracket
                # Use 3x the number of rookies as the "virtual" main bracket size
                # This ensures rookies-only tournaments are adjusted more conservatively
                max_main = num_rookies * 3

            # For each rookie in this tournament
            for rookie_entry in brackets['rookies']:
                rookie_player = rookie_entry['player']
                rookie_placement = rookie_entry['placement']
                result_obj = rookie_entry['result_obj']

                # Skip transitive comparisons for rookies-only tournaments
                # Using other rookies as anchors creates circular reasoning
                if not brackets['main']:
                    # Rookies-only: use simple fallback
                    fallback = max_main + rookie_placement
                    result_obj.placement = int(round(fallback))
                    continue

                # Find transitive comparisons
                estimates = []

                # Look at all tournaments this rookie has competed in
                for rookie_tournament_result in player_histories[rookie_player]:
                    other_tournament = rookie_tournament_result['tournament']

                    if other_tournament == tournament:
                        continue

                    # Find other players who competed in both tournaments
                    for other_player, other_history in player_histories.items():
                        if other_player == rookie_player:
                            continue

                        # Did other_player compete against rookie in other_tournament?
                        other_in_comparison = [
                            h for h in other_history
                            if h['tournament'] == other_tournament
                               and h['format'] == rookie_tournament_result['format']
                        ]
                        if not other_in_comparison:
                            continue

                        # Did other_player compete in current tournament?
                        # For tournaments with main brackets, look for '1v1'
                        # For rookies-only tournaments, look for '1v1 Rookies'
                        if brackets['main']:
                            # Tournament has main bracket
                            other_in_main = [
                                h for h in other_history
                                if h['tournament'] == tournament
                                   and h['format'] == '1v1'
                            ]
                        else:
                            # Rookies-only tournament
                            other_in_main = [
                                h for h in other_history
                                if h['tournament'] == tournament
                                   and h['format'] == '1v1 Rookies'
                            ]

                        if not other_in_main:
                            continue

                        # Calculate estimate based on performance delta
                        rookie_comp_place = rookie_tournament_result['placement']
                        other_comp_place = other_in_comparison[0]['placement']
                        other_main_place = other_in_main[0]['placement']

                        performance_delta = rookie_comp_place - other_comp_place
                        estimated = other_main_place + (performance_delta * 0.5)
                        estimates.append(estimated)

                # Determine final adjusted placement
                if estimates:
                    # Use median for robustness
                    import statistics
                    median_estimate = statistics.median(estimates)

                    # Apply modest penalty: transitive comparisons tend to be somewhat optimistic
                    # 1.3x multiplier accounts for the skill gap between rookie and main brackets
                    # More conservative than raw data, but not as aggressive as 1.6x
                    ROOKIE_PENALTY = 1.3
                    adjusted_estimate = median_estimate * ROOKIE_PENALTY

                    result_obj.placement = int(round(adjusted_estimate))
                else:
                    # No transitive data - use old system as fallback
                    # Place rookies below the main bracket
                    fallback = max_main + rookie_placement
                    result_obj.placement = int(round(fallback))

                # Check if this is a pure rookie (never competed in main bracket)
                player_main_history = [r for r in self.results
                                       if r.player_name == result_obj.player_name
                                       and r.is_1v1 and not r.is_1v1_rookies]

                if not player_main_history:
                    # Pure rookie - ensure they rank below all main bracket players
                    # Add +10 penalty
                    result_obj.placement = max(result_obj.placement, max_main + 10)

    def find_player_results(self, player: PlayerInput, verbose: bool = False, interactive: bool = True) -> List[
        TournamentResult]:
        """
        Find all tournament results for a given player.
        Uses company info when available for better matching.
        
        Args:
            player: The player to search for
            verbose: If True, prints detailed matching information
        """
        normalized_name = player.normalize_name()
        normalized_company = player.normalize_company()

        if verbose:
            # Color codes
            BLUE = '\033[94m'
            GREEN = '\033[92m'
            YELLOW = '\033[93m'
            RESET = '\033[0m'
            BOLD = '\033[1m'

            print(f"\n{BOLD}{BLUE}┌─ Matching Player{RESET}")
            print(f"{BLUE}│{RESET} Input:      {BOLD}'{player.name}'{RESET} [{player.company or 'None'}]")
            print(f"{BLUE}│{RESET} Normalized: '{normalized_name}' [{normalized_company or 'None'}]")

        # If company is provided, use it for matching
        if normalized_company:
            # Try full name match first with company
            full_key = f"{normalized_name}|{normalized_company}"
            if verbose:
                BLUE = '\033[94m'
                RESET = '\033[0m'
                print(f"{BLUE}│{RESET} Trying: full name + company → '{full_key}'")
            if full_key in self.player_results:
                results = self.player_results[full_key]

                # Also check for N/A entries for this player
                na_key = f"{normalized_name}|N/A"
                na_results = self.player_results.get(na_key, [])

                # Also check for similar company variants (e.g., Optus/Optiver typo)
                similar_company_results = []
                for key in self.player_results.keys():
                    if '|' not in key:
                        continue
                    key_name, key_company = key.rsplit('|', 1)
                    if key_name == normalized_name and key_company != normalized_company:
                        # Check if companies are similar (typo)
                        if self._companies_are_similar({normalized_company, key_company}):
                            similar_company_results.extend(self.player_results[key])

                # Handle similar company results (auto-merge in non-interactive, prompt in interactive)
                if similar_company_results:
                    similar_companies = set(r.company for r in similar_company_results)
                    if interactive:
                        YELLOW = '\033[93m'
                        BLUE = '\033[94m'
                        RESET = '\033[0m'
                        print(
                            f"\n{YELLOW}⚠{RESET}  Found additional results for '{player.name}' with similar company name:")
                        print(f"   {len(results)} results in {normalized_company}")
                        print(f"   {len(similar_company_results)} results in {', '.join(similar_companies)}")
                        print(f"   This looks like a typo or company name variant.")
                        response = input(f"   Merge these results? (y/n): ").strip().lower()
                        if response == 'y':
                            results = results + similar_company_results
                            if verbose:
                                print(f"{BLUE}│{RESET} Merging similar company results ({len(results)} total)")
                    else:
                        # In non-interactive mode, automatically merge similar companies
                        results = results + similar_company_results
                        if verbose:
                            BLUE = '\033[94m'
                            GREEN = '\033[92m'
                            RESET = '\033[0m'
                            print(
                                f"{BLUE}│{RESET} {GREEN}Auto-merged{RESET} similar company variant: {', '.join(similar_companies)}")

                if na_results:
                    # Found entries with both specified company and N/A
                    if interactive:
                        YELLOW = '\033[93m'
                        BLUE = '\033[94m'
                        RESET = '\033[0m'
                        print(
                            f"\n{YELLOW}⚠{RESET}  Found additional results for '{player.name}' marked as N/A company:")
                        print(f"   {len(results)} results in {normalized_company}")
                        print(f"   {len(na_results)} results in N/A")
                        response = input(f"   Include N/A results? (y/n): ").strip().lower()
                        if response == 'y':
                            results = results + na_results
                            if verbose:
                                print(f"{BLUE}│{RESET} Merging N/A results ({len(results)} total)")
                    else:
                        # In non-interactive mode, automatically merge N/A
                        results = results + na_results

                if verbose:
                    GREEN = '\033[92m'
                    BLUE = '\033[94m'
                    CYAN = '\033[96m'
                    RESET = '\033[0m'
                    BOLD = '\033[1m'
                    unique_names = set((r.player_name, r.company) for r in results)
                    print(
                        f"{BLUE}│{RESET} {GREEN}✓ Matched{RESET} via {BOLD}full name + company{RESET} ({len(results)} results)")
                    for name, company in unique_names:
                        print(
                            f"{BLUE}└──>{RESET} Input: '{player.name}' [{player.company or 'None'}] → Matched: {GREEN}{name}{RESET} [{CYAN}{company}{RESET}]")
                return results

            # Try first name match with company (eager matching)
            first_name = normalized_name.split()[0] if normalized_name else ""
            first_key = f"{first_name}|{normalized_company}"
            if verbose:
                BLUE = '\033[94m'
                RESET = '\033[0m'
                print(f"{BLUE}│{RESET} Trying: first name + company → '{first_key}'")
            if first_key in self.player_results:
                # Check if this is the only match or a clear match
                results = self.player_results[first_key]
                # Filter to only results from the specified company
                filtered = [r for r in results if r.company == normalized_company]
                if filtered:
                    if verbose:
                        GREEN = '\033[92m'
                        BLUE = '\033[94m'
                        CYAN = '\033[96m'
                        RESET = '\033[0m'
                        BOLD = '\033[1m'
                        unique_names = set((r.player_name, r.company) for r in filtered)
                        print(
                            f"{BLUE}│{RESET} {GREEN}✓ Matched{RESET} via {BOLD}first name + company{RESET} ({len(filtered)} results)")
                        for name, company in unique_names:
                            print(
                                f"{BLUE}└──>{RESET} Input: '{player.name}' [{player.company or 'None'}] → Matched: {GREEN}{name}{RESET} [{CYAN}{company}{RESET}]")
                    return filtered
                if verbose:
                    GREEN = '\033[92m'
                    BLUE = '\033[94m'
                    RESET = '\033[0m'
                    BOLD = '\033[1m'
                    print(
                        f"{BLUE}│{RESET} {GREEN}✓ Matched{RESET} via {BOLD}first name + company{RESET} (unfiltered, {len(results)} results)")
                    print(f"{BLUE}└──>{RESET} (multiple companies found)")
                return results

        # If no company specified, try Atlassian as default
        if not normalized_company:
            normalized_company = 'Atlassian'
            if verbose:
                YELLOW = '\033[93m'
                BLUE = '\033[94m'
                RESET = '\033[0m'
                print(f"{BLUE}│{RESET} {YELLOW}Note:{RESET} No company specified, defaulting to {normalized_company}")

            # Try full name match with default company
            full_key = f"{normalized_name}|{normalized_company}"
            if verbose:
                BLUE = '\033[94m'
                RESET = '\033[0m'
                print(f"{BLUE}│{RESET} Trying: full name + default company → '{full_key}'")
            if full_key in self.player_results:
                results = self.player_results[full_key]

                # Also check for N/A entries for this player
                na_key = f"{normalized_name}|N/A"
                na_results = self.player_results.get(na_key, [])

                if na_results:
                    # Found entries with both default company and N/A
                    if interactive:
                        YELLOW = '\033[93m'
                        BLUE = '\033[94m'
                        RESET = '\033[0m'
                        print(
                            f"\n{YELLOW}⚠{RESET}  Found additional results for '{player.name}' marked as N/A company:")
                        print(f"   {len(results)} results in {normalized_company}")
                        print(f"   {len(na_results)} results in N/A")
                        response = input(f"   Include N/A results? (y/n): ").strip().lower()
                        if response == 'y':
                            results = results + na_results
                            if verbose:
                                print(f"{BLUE}│{RESET} Merging N/A results ({len(results)} total)")
                    else:
                        # In non-interactive mode, automatically merge N/A
                        results = results + na_results

                if verbose:
                    GREEN = '\033[92m'
                    BLUE = '\033[94m'
                    CYAN = '\033[96m'
                    RESET = '\033[0m'
                    BOLD = '\033[1m'
                    unique_names = set((r.player_name, r.company) for r in results)
                    print(
                        f"{BLUE}│{RESET} {GREEN}✓ Matched{RESET} via {BOLD}full name + default company{RESET} ({len(results)} results)")
                    for name, company in unique_names:
                        print(
                            f"{BLUE}└──>{RESET} Input: '{player.name}' [{player.company or 'None'}] → Matched: {GREEN}{name}{RESET} [{CYAN}{company}{RESET}]")
                return results

            # Try first name match with default company
            first_name = normalized_name.split()[0] if normalized_name else ""
            first_key = f"{first_name}|{normalized_company}"
            if verbose:
                BLUE = '\033[94m'
                RESET = '\033[0m'
                print(f"{BLUE}│{RESET} Trying: first name + default company → '{first_key}'")
            if first_key in self.player_results:
                results = self.player_results[first_key]
                if verbose:
                    GREEN = '\033[92m'
                    BLUE = '\033[94m'
                    CYAN = '\033[96m'
                    RESET = '\033[0m'
                    BOLD = '\033[1m'
                    unique_names = set((r.player_name, r.company) for r in results)
                    print(
                        f"{BLUE}│{RESET} {GREEN}✓ Matched{RESET} via {BOLD}first name + default company{RESET} ({len(results)} results)")
                    for name, company in unique_names:
                        print(
                            f"{BLUE}└──>{RESET} Input: '{player.name}' [{player.company or 'None'}] → Matched: {GREEN}{name}{RESET} [{CYAN}{company}{RESET}]")
                return results

        # If no matches found, check if there's a name match with different company
        if verbose:
            RED = '\033[91m'
            BLUE = '\033[94m'
            YELLOW = '\033[93m'
            RESET = '\033[0m'
            print(f"{BLUE}└─{RESET} {RED}✗ No matches found{RESET}")

        # Check for potential cross-company matches (company changes or data entry errors)
        if normalized_name:
            normalized_name_lower = normalized_name.lower()
            potential_matches = []

            # Search for name matches across all companies
            for result in self.results:
                if result.player_name.lower() == normalized_name_lower:
                    potential_matches.append(result)

            if potential_matches:
                # Get unique companies for this player name
                companies = set(r.company for r in potential_matches)

                # If player specified a company and we found matches in OTHER companies
                if player.company and normalized_company not in companies:
                    if verbose:
                        YELLOW = '\033[93m'
                        BLUE = '\033[94m'
                        RESET = '\033[0m'
                        print(f"{BLUE}│{RESET} {YELLOW}Found name match in different company:{RESET}")
                        for company in companies:
                            count = len([r for r in potential_matches if r.company == company])
                            print(f"{BLUE}│{RESET}   - {count} results in {company}")

                    if interactive:
                        # Ask user if they want to use these results
                        YELLOW = '\033[93m'
                        RESET = '\033[0m'
                        print(f"\n{YELLOW}⚠{RESET}  Player '{player.name}' has results under different company:")
                        print(f"   Input company: {player.company or 'None'}")
                        print(f"   Found in: {', '.join(sorted(companies))}")
                        print(f"   This could be a company change or data entry error.")
                        response = input(f"   Merge all results for this player? (y/n): ").strip().lower()

                        if response == 'y':
                            if verbose:
                                GREEN = '\033[92m'
                                BLUE = '\033[94m'
                                RESET = '\033[0m'
                                print(
                                    f"{BLUE}└──>{RESET} {GREEN}Merging cross-company results ({len(potential_matches)} results){RESET}")
                            return potential_matches
                        else:
                            if verbose:
                                print(f"{BLUE}└─{RESET} Skipping cross-company match")
                    else:
                        # Non-interactive mode: auto-merge if companies are similar or single result
                        if len(companies) == 1 or self._companies_are_similar(companies):
                            if verbose:
                                GREEN = '\033[92m'
                                BLUE = '\033[94m'
                                RESET = '\033[0m'
                                print(
                                    f"{BLUE}└──>{RESET} {GREEN}Auto-merging similar companies ({len(potential_matches)} results){RESET}")
                            return potential_matches

                # If no company specified, check if there are multiple companies
                elif not player.company and len(companies) > 1:
                    if verbose:
                        YELLOW = '\033[93m'
                        BLUE = '\033[94m'
                        RESET = '\033[0m'
                        print(f"{BLUE}│{RESET} {YELLOW}Found name match across multiple companies:{RESET}")
                        for company in companies:
                            count = len([r for r in potential_matches if r.company == company])
                            print(f"{BLUE}│{RESET}   - {count} results in {company}")

                    if interactive:
                        print(f"\n{YELLOW}⚠{RESET}  Player '{player.name}' has results under multiple companies:")
                        print(f"   Found in: {', '.join(sorted(companies))}")
                        print(f"   This could be a company change or duplicate entries.")
                        response = input(f"   Use all results for this player? (y/n): ").strip().lower()

                        if response == 'y':
                            if verbose:
                                GREEN = '\033[92m'
                                BLUE = '\033[94m'
                                RESET = '\033[0m'
                                print(
                                    f"{BLUE}└──>{RESET} {GREEN}Using all results across companies ({len(potential_matches)} results){RESET}")
                            return potential_matches
                        else:
                            if verbose:
                                print(f"{BLUE}└─{RESET} Skipping multi-company match")

        return []

    def _companies_are_similar(self, companies: set) -> bool:
        """
        Check if companies are similar enough to auto-merge (e.g., typos like Optus/Optiver).
        
        Args:
            companies: Set of company names
        
        Returns:
            True if companies should be auto-merged
        """
        if len(companies) != 2:
            return False

        companies_list = list(companies)
        comp1, comp2 = companies_list[0].lower(), companies_list[1].lower()

        # Check for common typos/variants
        similar_pairs = [
            ('optiver', 'optus'),  # Common typo
            ('atlassian', 'atlas'),  # Abbreviation
            ('google', 'alphabet'),  # Parent company
        ]

        for pair in similar_pairs:
            if (comp1 in pair and comp2 in pair) or (comp2 in pair and comp1 in pair):
                return True

        # Use fuzzy matching for other cases
        from difflib import SequenceMatcher
        similarity = SequenceMatcher(None, comp1, comp2).ratio()
        return similarity > 0.8

    def calculate_player_score(self, results: List[TournamentResult], recency_decay: float = 0.4,
                               use_time_decay: bool = True) -> Dict[str, float]:
        """
        Calculate a scoring metric for a player based on their results.
        
        Uses weighted average of ALL 1v1 results with recency bias.
        More recent tournaments are weighted higher using exponential decay.
        This balances recency (so old results matter less) with consistency
        (so inconsistent but occasionally strong performers get credit).
        
        Args:
            results: List of tournament results
            recency_decay: Decay factor for older tournaments (0-1). Default 0.4 means
                          tournaments decay rapidly with age (half-life of ~60 days).
                          This strongly prioritizes recent performance over historical results.
        
        Returns a dict with:
        - '1v1_score': Primary scoring (weighted average with recency bias)
        - '2v2_score': Secondary scoring for tiebreaking (weighted average)
        - 'best_placement': Best 1v1 placement overall
        - 'most_recent_placement': Most recent 1v1 placement
        - 'num_tournaments': Number of 1v1 tournaments attended
        """
        if not results:
            return {
                '1v1_score': float('inf'),
                '2v2_score': float('inf'),
                'best_placement': float('inf'),
                'most_recent_placement': float('inf'),
                'num_tournaments': 0
            }

        # Filter by format
        # Note: Rookies placements are already adjusted to start after main 1v1
        one_v_one_results = [r for r in results if r.is_1v1 or r.is_1v1_rookies]
        two_v_two_results = [r for r in results if r.is_2v2]

        # Calculate weighted 1v1 score with recency bias
        if one_v_one_results:
            # Sort by date (most recent first)
            sorted_results = sorted(one_v_one_results, key=lambda x: x.date, reverse=True)

            weighted_sum = 0.0
            weight_total = 0.0

            if use_time_decay:
                # TIME-based decay: tournaments from 6 months ago get less weight than
                # tournaments from 3 months ago, regardless of player's participation frequency
                now = datetime.datetime.now()

                for result in sorted_results:
                    # Calculate days since tournament
                    days_ago = (now - result.date).days
                    # Decay over ~3 months (90 days): 0.4^(days/90)
                    # This gives tournaments a ~60 day half-life, strongly prioritizing recent results
                    weight = recency_decay ** (days_ago / 90)

                    # Apply inverse power scaling to placement with exponent 0.75
                    # This strongly emphasizes top placements (2nd vs 3rd matters MUCH more than 13th vs 17th)
                    # Reasoning: winning at the top requires beating stronger opponents across more matches
                    # Using 1/p^0.75 creates these scores (lower is better):
                    # 1st→1.0, 2nd→1.68, 3rd→2.28, 5th→3.34, 9th→5.24, 13th→6.76, 17th→8.20, 25th→11.18, 33rd→13.93
                    # Key: 2nd→3rd diff is 0.60, while 13th→17th diff is 1.44
                    # So 2nd→3rd is MORE significant (ratio: 2.4x) because we use inverse (smaller changes at top matter more)
                    inverse_placement = 1.0 / (result.placement ** 0.75)

                    # Store the reciprocal so lower placements still give worse (higher) scores
                    # We'll convert back after averaging
                    weighted_sum += inverse_placement * weight
                    weight_total += weight
            else:
                # POSITION-based decay: each tournament gets exponentially less weight
                # based on how many tournaments ago it was for this player
                for i, result in enumerate(sorted_results):
                    weight = recency_decay ** i  # Exponential decay: 1.0, 0.6, 0.36, 0.22, ...
                    # Apply same inverse power scaling as time-based decay
                    inverse_placement = 1.0 / (result.placement ** 0.75)
                    weighted_sum += inverse_placement * weight
                    weight_total += weight

            # For inverse scoring, convert the average back to a "placement-like" score
            # where higher placement numbers give higher (worse) scores
            avg_inverse = weighted_sum / weight_total
            one_v_one_score = 1.0 / avg_inverse if avg_inverse > 0 else float('inf')

            # Note: We no longer apply a confidence bonus for limited tournament history.
            # Instead, we blend in 2v2 data below for players with sparse 1v1 data.
            num_tournaments = len(one_v_one_results)

            best_placement = min(r.placement for r in one_v_one_results)
            most_recent_placement = sorted_results[0].placement
        else:
            one_v_one_score = float('inf')
            best_placement = float('inf')
            most_recent_placement = float('inf')

        # Calculate weighted 2v2 score (for tiebreaking or fallback)
        if two_v_two_results:
            sorted_2v2 = sorted(two_v_two_results, key=lambda x: x.date, reverse=True)

            weighted_sum_2v2 = 0.0
            weight_total_2v2 = 0.0

            if use_time_decay:
                # Use same time-based decay as 1v1, but with inverse power scaling
                now = datetime.datetime.now()

                for result in sorted_2v2:
                    days_ago = (now - result.date).days
                    weight = recency_decay ** (days_ago / 90)
                    inverse_placement = 1.0 / (result.placement ** 0.75)
                    weighted_sum_2v2 += inverse_placement * weight
                    weight_total_2v2 += weight

                avg_inverse_2v2 = weighted_sum_2v2 / weight_total_2v2
                two_v_two_score = 1.0 / avg_inverse_2v2 if avg_inverse_2v2 > 0 else float('inf')
            else:
                # Position-based decay
                for i, result in enumerate(sorted_2v2):
                    weight = recency_decay ** i
                    inverse_placement = 1.0 / (result.placement ** 0.75)
                    weighted_sum_2v2 += inverse_placement * weight
                    weight_total_2v2 += weight

                avg_inverse_2v2 = weighted_sum_2v2 / weight_total_2v2
                two_v_two_score = 1.0 / avg_inverse_2v2 if avg_inverse_2v2 > 0 else float('inf')
        else:
            two_v_two_score = float('inf')

        # Blend 2v2 data into 1v1 score for players with sparse 1v1 history
        # This provides more signal for players who haven't competed much in 1v1
        # without penalizing them for having limited data
        num_1v1_tournaments = len(one_v_one_results)
        blended_1v1_score = one_v_one_score
        
        if one_v_one_score != float('inf') and two_v_two_score != float('inf'):
            # Determine blend weight based on 1v1 tournament count:
            # - 3+ tournaments: 100% 1v1 (no blending)
            # - 2 tournaments: 75% 1v1 + 25% 2v2
            # - 1 tournament: 50% 1v1 + 50% 2v2
            if num_1v1_tournaments >= 3:
                blend_weight = 0.0
            elif num_1v1_tournaments == 2:
                blend_weight = 0.25
            elif num_1v1_tournaments == 1:
                blend_weight = 0.50
            else:
                blend_weight = 1.0
            
            if blend_weight > 0:
                blended_1v1_score = (1 - blend_weight) * one_v_one_score + blend_weight * two_v_two_score

        # Track the most recent 1v1 tournament date for staleness calculation
        if one_v_one_results:
            sorted_by_date = sorted(one_v_one_results, key=lambda x: x.date, reverse=True)
            most_recent_tournament_date = sorted_by_date[0].date
        else:
            most_recent_tournament_date = None

        return {
            '1v1_score': blended_1v1_score,
            '2v2_score': two_v_two_score,
            'best_placement': best_placement,
            'most_recent_placement': most_recent_placement,
            'num_tournaments': num_1v1_tournaments,
            'most_recent_tournament_date': most_recent_tournament_date
        }

    def _calculate_head_to_head_adjustments(self, player_inputs: List[PlayerInput], player_results_map: Dict) -> Tuple[
        Dict[str, float], Dict[str, List]]:
        """
        Calculate head-to-head adjustments based on shared tournament performance.
        
        When two players compete in the same tournament, the one who places higher
        gets a small bonus. More recent shared tournaments have more weight.
        
        Returns:
            - Dict mapping player name to adjustment value (negative = bonus/better)
            - Dict mapping player name to list of (tournament, placement, adjustment, participants) tuples
        """
        adjustments = {player.name: 0.0 for player in player_inputs}
        h2h_details = {player.name: [] for player in player_inputs}

        # Get all 1v1 tournaments with their participants
        tournaments = {}  # tournament -> [(player_name, placement, date)]

        for player in player_inputs:
            if player.name not in player_results_map:
                continue
            results = player_results_map[player.name]
            for result in results:
                if result.is_1v1 or result.is_1v1_rookies:
                    if result.tournament not in tournaments:
                        tournaments[result.tournament] = []
                    tournaments[result.tournament].append((player.name, result.placement, result.date))

        # For each tournament with multiple participants, apply head-to-head adjustments
        for tournament, participants in tournaments.items():
            if len(participants) < 2:
                continue

            # Sort by placement (absolute tournament placement)
            participants.sort(key=lambda x: x[1])
            date = participants[0][2]  # All same tournament, same date

            # Calculate recency weight for this tournament
            # More recent tournaments have more influence on adjustments
            days_ago = (datetime.datetime.now() - date).days
            recency_weight = 0.6 ** (days_ago / 60)  # Decay over ~2 months (matches score decay)

            # Give each player a small adjustment based on their relative position
            # AMONG the seeded players (not absolute tournament placement)
            num_participants = len(participants)

            for i, (player_name, absolute_placement, _) in enumerate(participants):
                # Use rank among seeded players (1-indexed): 1st, 2nd, 3rd, etc.
                relative_rank = i + 1

                # Calculate average rank among seeded players
                avg_rank = (num_participants + 1) / 2.0

                # Normalized difference: -0.5 (best) to +0.5 (worst)
                # If 4 players: ranks 1,2,3,4 → avg 2.5
                # Rank 1: (1 - 2.5) / 4 = -0.375
                # Rank 4: (4 - 2.5) / 4 = +0.375
                normalized_diff = (relative_rank - avg_rank) / num_participants

                adjustment = normalized_diff * 2.0 * recency_weight  # Max ±1.0 per tournament (increased from 1.0)

                adjustments[player_name] += adjustment

                # Store details for this tournament
                h2h_details[player_name].append({
                    'tournament': tournament,
                    'placement': absolute_placement,  # Store absolute for display
                    'relative_rank': relative_rank,  # Store relative rank among seeded
                    'adjustment': adjustment,
                    'participants': [(p[0], p[1]) for p in participants],  # (name, absolute_placement) pairs
                    'date': date
                })

        return adjustments, h2h_details

    def seed_players(self, player_inputs: List[PlayerInput], verbose: bool = False, interactive: bool = True,
                     use_time_decay: bool = True) -> List[Dict]:
        """
        Seed a list of players based on their historical performance.
        
        Args:
            player_inputs: List of players to seed
            verbose: If True, prints detailed matching information
        
        Returns a list of dicts with player info and seeding details, sorted by seed.
        """
        seeded_players = []
        unmatched_players = []
        player_results_map = {}

        for player in player_inputs:
            results = self.find_player_results(player, verbose=verbose, interactive=interactive)
            score_info = self.calculate_player_score(results, use_time_decay=use_time_decay)
            player_results_map[player.name] = results

            # Determine the company to display
            # Priority: 1) normalized company from input, 2) most common company from results
            if player.company:
                matched_company = player.normalize_company()
            elif results:
                # Use the most common company from results
                companies = [r.company for r in results]
                matched_company = max(set(companies), key=companies.count)
            else:
                matched_company = None

            player_info = {
                'name': player.name,
                'company': matched_company or 'Unknown',
                'results_found': len(results),
                'score': score_info,
                'has_history': len(results) > 0,
                'results': results  # Store for head-to-head
            }

            if len(results) > 0:
                seeded_players.append(player_info)
            else:
                unmatched_players.append(player_info)

        # Calculate head-to-head adjustments
        h2h_adjustments, h2h_details = self._calculate_head_to_head_adjustments(player_inputs, player_results_map)

        # Build list of all 1v1 tournament dates for staleness calculation
        all_tournament_dates = set()
        for result in self.results:
            if result.is_1v1 or result.is_1v1_rookies:
                all_tournament_dates.add(result.date)
        sorted_tournament_dates = sorted(all_tournament_dates, reverse=True)

        # Apply adjustments to scores and handle 2v2 fallback
        for player in seeded_players:
            adjustment = h2h_adjustments.get(player['name'], 0.0)

            # If player has 1v1 data, use it with H2H adjustment
            if player['score']['1v1_score'] != float('inf'):
                player['score']['1v1_score'] += adjustment
                
                # Calculate tournament-based staleness penalty
                # If a player has missed 2+ tournaments, apply a small penalty
                # scaled by their track record (strong performers get reduced penalty)
                staleness_penalty = 0.0
                player_last_tournament = player['score'].get('most_recent_tournament_date')
                if player_last_tournament and sorted_tournament_dates:
                    # Count tournaments missed (tournaments that happened after player's last)
                    tournaments_missed = sum(1 for t_date in sorted_tournament_dates if t_date > player_last_tournament)
                    
                    if tournaments_missed >= 2:
                        # Scale penalty by track record: best_placement / 10, capped 0.5-1.5
                        best_placement = player['score']['best_placement']
                        if best_placement != float('inf'):
                            scale = min(1.5, max(0.5, best_placement / 10))
                        else:
                            scale = 1.0
                        
                        # Base penalty: 0.3 per tournament missed beyond 1
                        # Cap at 0.3 total to be forgiving to players who can't attend frequently
                        raw_penalty = 0.3 * (tournaments_missed - 1) * scale
                        staleness_penalty = min(0.3, raw_penalty)
                
                player['staleness_penalty'] = staleness_penalty
                player['score']['1v1_score'] += staleness_penalty
                player['primary_score'] = player['score']['1v1_score']
                player['score_source'] = '1v1'
            # If no 1v1 data but has 2v2 data, use 2v2 as fallback
            elif player['score']['2v2_score'] != float('inf'):
                # Add a penalty to 2v2-only players so they rank below 1v1 players
                # Use a large base penalty, then add the 2v2 score
                penalty = 100.0  # Places them well below 1v1 players
                player['primary_score'] = penalty + player['score']['2v2_score']
                player['score_source'] = '2v2 (fallback)'
            else:
                player['primary_score'] = float('inf')
                player['score_source'] = 'none'

            player['h2h_adjustment'] = adjustment
            player['h2h_details'] = h2h_details.get(player['name'], [])

        # Sort players by primary score (which is either 1v1+H2H, or 2v2+penalty)
        # Then by 2v2 as tiebreaker
        seeded_players.sort(key=lambda x: (
            x['primary_score'],
            x['score']['2v2_score']
        ))

        # Assign seed numbers
        for i, player in enumerate(seeded_players, start=1):
            player['seed'] = i

        # Unmatched players get seeded last (randomly or alphabetically)
        for i, player in enumerate(unmatched_players, start=len(seeded_players) + 1):
            player['seed'] = i

        return seeded_players + unmatched_players


def clean_player_entry(line: str) -> Tuple[str, Optional[str]]:
    """
    Clean a messy player entry and extract name and company.
    
    Handles formats like:
    - "1 [Atlas]@Lucina"
    - "[Google] Mako RutledgeGoogle"
    - "Jack Morrison (Susquehanna, Smashclub alum) (Host @Robin)"
    - "[Relevance AI] Satya Vaswani"
    
    Returns: (cleaned_name, company_code)
    """
    original = line

    # Remove leading numbers (like "1 ", "12 ")
    line = re.sub(r'^\s*\d+\s*', '', line)

    # Extract company from [brackets]
    company = None
    bracket_match = re.search(r'\[([^\]]+)\]', line)
    if bracket_match:
        company = bracket_match.group(1).strip()
        line = re.sub(r'\[[^\]]+\]', '', line)

    # Remove parenthetical information FIRST (like "(Host ...)" or "(Susquehanna...)")
    # This removes @ symbols that refer to other people (hosts, etc.)
    line = re.sub(r'\([^)]*\)', '', line)

    # NOW check for @ symbol (indicates Atlassian employee)
    has_at_symbol = '@' in line

    # Remove @ symbols
    line = line.replace('@', '')

    # Remove everything after " - " (comment/description)
    if ' - ' in line:
        line = line.split(' - ')[0].strip()

    if company:
        # Normalize using aliases (case-insensitive)
        for alias, code in COMPANY_ALIASES.items():
            if company.lower() == alias.lower():
                company = code
                break

    # Clean up the name
    line = line.strip()

    # Remove duplicate company name at the end (e.g., "Mako RutledgeGoogle")
    if company:
        # Try to remove company name from end of line
        for alias in COMPANY_ALIASES.keys():
            if line.lower().endswith(alias.lower()):
                line = line[:-len(alias)].strip()
                break

    # Remove "Switch" at the end (console preference notation)
    if line.lower().endswith(' switch'):
        line = line[:-7].strip()

    # Remove "Relevance" at the end if company is Relevance AI
    if company == 'REL' and line.lower().endswith(' relevance'):
        line = line[:-10].strip()

    # Final cleanup
    name = ' '.join(line.split())  # Normalize whitespace

    # Infer company if not specified
    if not company and has_at_symbol:
        # @ symbol indicates Atlassian employee
        company = 'ATL'
    # Otherwise leave as None (will be handled by caller)

    return name, company


def find_similar_player(name: str, company: Optional[str],
                        calculator: 'SeedingCalculator') -> Optional[Tuple[str, float]]:
    """
    Find similar player names in historical data using fuzzy matching.
    
    Returns: (matched_name, similarity_score) or None
    """
    if not name:
        return None

    normalized_name = name.lower().strip()
    normalized_company = company.upper() if company else None

    # Get all unique player names from historical data
    all_players = set()
    for result in calculator.results:
        if normalized_company:
            # Normalize company for comparison
            result_company = result.company.upper()
            if 'ATLAS' in result_company or result_company == 'ATLASSIAN':
                result_company = 'ATL'
            elif result_company == 'GOOGLE':
                result_company = 'GOOG'

            # Only consider players from the same company
            if normalized_company == 'ATL' and result_company == 'ATL':
                all_players.add(result.player_name)
            elif normalized_company == result_company:
                all_players.add(result.player_name)
        else:
            all_players.add(result.player_name)

    # Find best match using fuzzy string matching
    best_match = None
    best_score = 0.0

    for player_name in all_players:
        ratio = SequenceMatcher(None, normalized_name, player_name.lower()).ratio()

        # Also check first name + last name separately
        input_parts = normalized_name.split()
        player_parts = player_name.lower().split()

        if len(input_parts) >= 2 and len(player_parts) >= 2:
            # Check if first and last names match
            first_match = SequenceMatcher(None, input_parts[0], player_parts[0]).ratio()
            last_match = SequenceMatcher(None, input_parts[-1], player_parts[-1]).ratio()
            avg_ratio = (first_match + last_match) / 2
            ratio = max(ratio, avg_ratio)

        if ratio > best_score:
            best_score = ratio
            best_match = player_name

    if best_score >= 0.6:  # Minimum threshold for suggesting
        return (best_match, best_score)

    return None


def smart_parse_player_list(player_list_str: str,
                            calculator: Optional['SeedingCalculator'] = None,
                            interactive: bool = True,
                            verbose: bool = False) -> List[PlayerInput]:
    """
    Intelligently parse a player list with fuzzy matching and user confirmation.
    
    Handles messy formats, finds similar names in historical data, and prompts
    user for confirmation when uncertain.
    
    Args:
        player_list_str: Raw player list (can be messy)
        calculator: SeedingCalculator for fuzzy matching against history
        interactive: If True, prompts user for confirmation
        verbose: If True, shows detailed parsing information
    """
    players = []
    lines = player_list_str.strip().split('\n')

    print(f"\nParsing {len(lines)} player entries...")

    for line in lines:
        line = line.strip()
        if not line:
            continue

        # Clean the entry
        original_line = line
        name, company = clean_player_entry(line)

        if not name:
            continue

        if verbose:
            print(f"\n  Raw: '{original_line}'")
            print(f"  Parsed: '{name}' [{company or 'None'}]")

        # Try fuzzy matching if we have historical data
        if calculator and interactive:
            similar = find_similar_player(name, company, calculator)

            if similar:
                matched_name, score = similar

                if score >= 0.9:
                    # Very high confidence - use it
                    # Show matched company as well
                    matched_results = calculator.find_player_results(PlayerInput(matched_name, company), verbose=False,
                                                                     interactive=False)
                    if matched_results:
                        matched_company = matched_results[0].company
                        print(f"-> {name} => {matched_name} [{matched_company}] (exact match)")
                    else:
                        print(f"-> {name} => {matched_name} (exact match)")
                    name = matched_name
                elif score >= 0.75:
                    # High confidence - suggest but allow override
                    print(f"\nDid you mean: '{matched_name}' instead of '{name}'? (similarity: {score:.0%})")
                    response = input("   Press Enter to accept, or type the correct name: ").strip()
                    if not response:
                        print(f"   Using: {matched_name}")
                        name = matched_name
                    else:
                        print(f"   Using: {response}")
                        name = response
                elif score >= 0.6:
                    # Medium confidence - ask for confirmation
                    print(f"\nPossible match for '{name}': '{matched_name}' (similarity: {score:.0%})")
                    response = input("   Use this name? (y/n): ").strip().lower()
                    if response == 'y':
                        print(f"   Using: {matched_name}")
                        name = matched_name
                    else:
                        print(f"   Using original: {name}")

        # Note when company is not specified (don't prompt by default)
        if not company:
            print(f"Note: No company specified for: {name}")
            # Leave as None - will match against all companies in history

        players.append(PlayerInput(name=name, company=company))

    print(f"\nParsed {len(players)} players\n")
    return players


def parse_player_list(player_list_str: str, prompt_for_company: bool = False) -> List[PlayerInput]:
    """
    Parse a player list string into PlayerInput objects.
    
    Supports formats like:
    - "John Smith [ATL]"
    - "[Atlassian] John Smith"
    - "John Smith"
    
    Args:
        player_list_str: String with player names (one per line)
        prompt_for_company: If True, prompts user for company when not specified
    """
    players = []
    lines = player_list_str.strip().split('\n')

    for line in lines:
        line = line.strip()
        if not line:
            continue

        # Try to extract company in brackets
        company = None
        name = line

        # Check for company at start: [ATL] Name
        if line.startswith('['):
            end_bracket = line.find(']')
            if end_bracket > 0:
                company = line[1:end_bracket]
                name = line[end_bracket + 1:].strip()
        # Check for company at end: Name [ATL]
        elif '[' in line and line.endswith(']'):
            start_bracket = line.rfind('[')
            company = line[start_bracket + 1:-1]
            name = line[:start_bracket].strip()

        # Prompt for company if not found and prompting is explicitly enabled
        if company is None and prompt_for_company:
            # Generate prompt from COMPANY_CODES
            codes_list = '/'.join(sorted(COMPANY_CODES.keys()))
            print(f"\nCompany not specified for: {name}")
            print(f"Enter company code ({codes_list})")
            print("Or enter 'N/A' or 'none' for no company")
            print("Or press Enter to skip:")
            company_input = input("> ").strip()

            # Handle N/A / none / empty
            if company_input.upper() in ['N/A', 'NA', 'NONE'] or not company_input:
                company = None
            else:
                company = company_input

        players.append(PlayerInput(name=name, company=company))

    return players


def main():
    """Example usage of the seeding algorithm."""
    # Initialize the calculator
    calculator = SeedingCalculator('Smashclub Tournament Results Database.csv')

    # Example player list
    example_players_str = """
    Jigglypuff [ATL]
    Byleth [ATL]
    Joseph [OPT]
    Mitchell Merry [ATL]
    Kirby [ATL]
    Justin Or [CAN]
    """

    players = parse_player_list(example_players_str)
    seeded = calculator.seed_players(players)

    print("\nSeeding Results:")
    print("=" * 80)
    for player in seeded:
        print(f"Seed {player['seed']}: {player['name']} ({player['company']})")
        if player['has_history']:
            score = player['score']
            print(f"  Last 2 Best: {score['last_2_best']}, All-time Best: {score['best_placement']}, "
                  f"Tournaments: {score['num_tournaments']}")
        else:
            print(f"  No tournament history found")
        print()


if __name__ == '__main__':
    main()
