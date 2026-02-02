"""
Output formatting and display utilities for the SSBU Tournament Seeding Tool.

This module handles all terminal output including colors, tables, and bracket display.
"""

from colorama import Fore, Style, init as colorama_init
from tabulate import tabulate
from typing import List, Dict, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from seeding_algorithm import SeedingCalculator

# Initialize colorama for cross-platform support (especially Windows)
colorama_init()

# Terminal color constants
BLUE = Fore.LIGHTBLUE_EX
GREEN = Fore.LIGHTGREEN_EX
YELLOW = Fore.LIGHTYELLOW_EX
RED = Fore.LIGHTRED_EX
CYAN = Fore.LIGHTCYAN_EX
MAGENTA = Fore.LIGHTMAGENTA_EX
WHITE = Fore.WHITE
RESET = Style.RESET_ALL
BOLD = Style.BRIGHT
DIM = Style.DIM


def _ordinal(n: int) -> str:
    """Convert number to ordinal suffix (st, nd, rd, th)."""
    if 10 <= n % 100 <= 20:
        suffix = 'th'
    else:
        suffix = {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')
    return suffix


def print_header(title: str) -> None:
    """Print a styled section header."""
    print(f"\n{BOLD}{CYAN}{'=' * 80}{RESET}")
    print(f"{BOLD}{WHITE}{title}{RESET}")
    print(f"{BOLD}{CYAN}{'=' * 80}{RESET}")


def print_subheader(title: str) -> None:
    """Print a styled subsection header."""
    print(f"\n{BOLD}{BLUE}{title}{RESET}")
    print(f"{BLUE}{'-' * 40}{RESET}")


def print_legend() -> None:
    """Print the scoring legend."""
    print(f"\n{DIM}Legend:{RESET}")
    print(f"  {DIM}Score = Lower is better  |  Trn = Tournaments attended  |  2v2 = Tiebreaker only{RESET}")


def print_tournament_shorthands(calculator: 'SeedingCalculator') -> None:
    """Print tournament shorthand codes."""
    print(f"\n{DIM}Tournament Shorthands:{RESET}")
    shorthands = sorted(calculator.tournament_shorthands.items(), key=lambda x: x[1])
    shorthand_strs = [f"{CYAN}{sh}{RESET}={name.replace('https://challonge.com/', '')[:30]}" for name, sh in shorthands]
    print(f"  {' | '.join(shorthand_strs[:4])}")
    if len(shorthand_strs) > 4:
        print(f"  {' | '.join(shorthand_strs[4:])}")


def format_seed(seed: int) -> str:
    """Format a seed number with color based on ranking."""
    if seed <= 3:
        return f"{BOLD}{YELLOW}{seed}{RESET}"  # Gold for top 3
    elif seed <= 8:
        return f"{BOLD}{WHITE}{seed}{RESET}"  # White for top 8
    else:
        return f"{DIM}{seed}{RESET}"  # Dim for others


def format_score(score_val: str, is_fallback: bool = False) -> str:
    """Format a score value with appropriate color."""
    if score_val == 'N/A':
        return f"{DIM}N/A{RESET}"
    if is_fallback:
        return f"{YELLOW}{score_val}{RESET}"  # Yellow for 2v2 fallback
    return f"{GREEN}{score_val}{RESET}"


def format_placement(placement: str) -> str:
    """Format a placement value with color."""
    if placement == '-' or placement == 'N/A':
        return f"{DIM}{placement}{RESET}"
    try:
        p = int(placement)
        if p <= 3:
            return f"{BOLD}{YELLOW}{placement}{RESET}"
        elif p <= 8:
            return f"{GREEN}{placement}{RESET}"
        else:
            return f"{WHITE}{placement}{RESET}"
    except ValueError:
        return placement


def format_player_name(name: str, max_len: int = 22) -> str:
    """Format a player name, truncating if needed."""
    if len(name) > max_len:
        name = name[:max_len - 3] + "..."
    return f"{BOLD}{WHITE}{name}{RESET}"


def format_company(company: str) -> str:
    """Format a company code with color."""
    return f"{CYAN}{company[:6]}{RESET}"


def format_recent_results(player: Dict, calculator: 'SeedingCalculator') -> str:
    """Format recent results string with colors."""
    if 'recent_results' not in player or not player['recent_results']:
        return f"{DIM}No history{RESET}"
    
    results_parts = []
    one_v_one_results = [r for r in player['recent_results'] if r['format'] in ['1v1', '1v1 Rookies']]
    
    for result in one_v_one_results[:3]:
        placement = result['placement']
        date_str = result['date'].strftime('%d %b %y')
        tournament_name = result['tournament']
        shorthand = calculator.tournament_shorthands.get(tournament_name, 'UNK')
        
        # Color the placement
        if placement <= 3:
            place_color = f"{BOLD}{YELLOW}"
        elif placement <= 8:
            place_color = f"{GREEN}"
        else:
            place_color = f"{WHITE}"
        
        results_parts.append(
            f"{CYAN}{shorthand}{RESET} {place_color}{placement}{_ordinal(placement)}{RESET} {DIM}{date_str}{RESET}"
        )
    
    return " | ".join(results_parts)


def print_seeding_results(seeded_players: List[Dict], show_details: bool = False, 
                          calculator: Optional['SeedingCalculator'] = None, 
                          compact: bool = False, verbose: bool = False) -> None:
    """Print seeding results in a formatted way."""

    if compact and show_details:
        print_header("TOURNAMENT SEEDING RESULTS")
        print_legend()
        
        if calculator:
            print_tournament_shorthands(calculator)

        # Build table data
        table_data = []
        if verbose:
            headers = ["Seed", "Name", "Co", "Base", "H2H", "Final", "Best", "Recent", "Trn", "Days", "Recent Results"]
        else:
            headers = ["Seed", "Name", "Co", "Score", "Best", "Recent", "Trn", "2v2", "Recent Results (Most Recent First)"]

        for player in seeded_players:
            seed = format_seed(player['seed'])
            name = player['name']
            if len(name) > 22:
                name = name[:19] + "..."
            name = format_player_name(name)
            company = format_company(player['company'])

            if player['has_history']:
                score = player['score']
                score_source = player.get('score_source', '1v1')
                is_fallback = score_source == '2v2 (fallback)'
                
                if is_fallback:
                    score_val = format_score(f"{score['2v2_score']:.2f}*", is_fallback=True)
                    best = f"{DIM}-{RESET}"
                    recent = f"{DIM}-{RESET}"
                    tournaments = f"{DIM}0{RESET}"
                    two_v_two = format_score(f"{score['2v2_score']:.2f}")
                else:
                    score_val = format_score(f"{score['1v1_score']:.2f}")
                    best = format_placement(f"{score['best_placement']:.0f}")
                    recent = format_placement(f"{score['most_recent_placement']:.0f}")
                    tournaments = f"{WHITE}{score['num_tournaments']}{RESET}"
                    two_v_two = format_score(f"{score['2v2_score']:.2f}") if score['2v2_score'] != float('inf') else f"{DIM}-{RESET}"

                recent_str = format_recent_results(player, calculator) if calculator else ""

                if verbose:
                    base_score = score['1v1_score'] - player.get('h2h_adjustment', 0)
                    h2h_adj = player.get('h2h_adjustment', 0)
                    final_score = score['1v1_score']

                    from datetime import datetime
                    if player.get('results'):
                        one_v_one_results = [r for r in player['results'] if r.is_1v1 or r.is_1v1_rookies]
                        if one_v_one_results:
                            most_recent = max(one_v_one_results, key=lambda x: x.date)
                            days_since = (datetime.now() - most_recent.date).days
                        else:
                            days_since = '-'
                    else:
                        days_since = '-'

                    # Color H2H adjustment
                    if h2h_adj < -0.1:
                        h2h_str = f"{GREEN}{h2h_adj:+.2f}{RESET}"
                    elif h2h_adj > 0.1:
                        h2h_str = f"{RED}{h2h_adj:+.2f}{RESET}"
                    else:
                        h2h_str = f"{DIM}{h2h_adj:+.2f}{RESET}"

                    table_data.append([seed, name, company, f"{base_score:.2f}", h2h_str,
                                       format_score(f"{final_score:.2f}"), best, recent, tournaments, days_since, recent_str])
                else:
                    table_data.append([seed, name, company, score_val, best, recent, tournaments, two_v_two, recent_str])
            else:
                if verbose:
                    table_data.append([seed, name, company, f'{DIM}N/A{RESET}', f'{DIM}-{RESET}', 
                                      f'{DIM}N/A{RESET}', f'{DIM}-{RESET}', f'{DIM}-{RESET}', 
                                      f'{DIM}0{RESET}', f'{DIM}No tournament history{RESET}'])
                else:
                    table_data.append([seed, name, company, f'{DIM}N/A{RESET}', f'{DIM}-{RESET}', 
                                      f'{DIM}-{RESET}', f'{DIM}0{RESET}', f'{DIM}-{RESET}', 
                                      f'{DIM}No tournament history{RESET}'])

        print("\n" + tabulate(table_data, headers=headers, tablefmt="heavy_grid"))

        # Scoring notes
        print(f"\n{DIM}Note: 'Score' uses inverse power scaling (1/p^0.75) so top placements matter much more.{RESET}")
        print(f"{DIM}      Example: 1st→1.0, 2nd→1.68, 3rd→2.28, 5th→3.34, 9th→5.24, 13th→6.76, 17th→8.20{RESET}")
        print(f"{DIM}      Peak Placement Bonus: 1st→-2.0, 2nd→-1.27, 3rd→-0.94, 5th→-0.62, 7th→-0.44, 10th→-0.29{RESET}")
        print(f"{DIM}      Recent results strongly prioritized (decay: 0.4^(days/90), ~60 day half-life){RESET}")
        print(f"{DIM}      * = Score based on 2v2 results (no 1v1 data available, ranked near bottom){RESET}")

        # H2H details for verbose mode
        if verbose:
            print_header("HEAD-TO-HEAD ADJUSTMENTS")
            print(f"\n{DIM}How H2H works: When players compete in the same tournament, those who place{RESET}")
            print(f"{DIM}better than average (among seeded players) get a bonus, worse get a penalty.{RESET}")
            print(f"{DIM}Adjustments scale with placement spread and decay over 60 days.{RESET}")
            print(f"{DIM}Max adjustment per tournament: ±1.0 per player.{RESET}")
            
            print(f"\n{DIM}Format: Name | Total | (biggest contributor){RESET}\n")

            players_with_h2h = [p for p in seeded_players if abs(p.get('h2h_adjustment', 0)) > 0.1]

            if players_with_h2h:
                for player in players_with_h2h:
                    h2h_adj = player.get('h2h_adjustment', 0)
                    h2h_details = player.get('h2h_details', [])

                    if h2h_details:
                        sorted_details = sorted(h2h_details, key=lambda x: abs(x['adjustment']), reverse=True)
                        top_tournament = sorted_details[0]

                        shorthand = calculator.tournament_shorthands.get(top_tournament['tournament'], 'UNK')
                        relative_rank = top_tournament['relative_rank']
                        num_participants = len(top_tournament['participants'])
                        top_adj = top_tournament['adjustment']
                        num_tournaments = len(h2h_details)

                        # Color the adjustment
                        if h2h_adj < 0:
                            adj_color = GREEN
                        else:
                            adj_color = RED

                        print(f"  {WHITE}{player['name']:20s}{RESET} {adj_color}{h2h_adj:+.2f}{RESET}  "
                              f"(biggest: {CYAN}{shorthand}{RESET} ranked {relative_rank}{_ordinal(relative_rank)}/{num_participants} = {adj_color}{top_adj:+.2f}{RESET}, {num_tournaments} total)")
            else:
                print(f"{DIM}No significant H2H adjustments (all below ±0.1).{RESET}")
    else:
        # Original non-compact format
        print_header("TOURNAMENT SEEDING RESULTS")

        for player in seeded_players:
            seed_str = format_seed(player['seed'])
            print(f"\n{BOLD}Seed {seed_str}: {format_player_name(player['name'])} ({format_company(player['company'])}){RESET}")

            if show_details:
                if player['has_history']:
                    score = player['score']
                    score_1v1 = f"{score['1v1_score']:.2f}"
                    best_place = f"{score['best_placement']:.0f}"
                    recent_place = f"{score['most_recent_placement']:.0f}"
                    print(f"  📊 Weighted Score: {format_score(score_1v1)}")
                    if 'peak_bonus' in score and score['peak_bonus'] != 0:
                        print(f"  ⭐ Peak Bonus: {GREEN}{score['peak_bonus']:.1f}{RESET} (for {format_placement(best_place)} place)")
                    print(f"  🏆 All-time Best: {format_placement(best_place)}")
                    print(f"  🎯 Most Recent: {format_placement(recent_place)}")
                    print(f"  🎮 Tournaments: {WHITE}{score['num_tournaments']}{RESET}")
                    if score['2v2_score'] != float('inf'):
                        score_2v2 = f"{score['2v2_score']:.2f}"
                        print(f"  👥 2v2 Score: {format_score(score_2v2)} {DIM}(tiebreaker){RESET}")

                    if 'recent_results' in player and player['recent_results']:
                        print(f"  {GREEN}Recent Results:{RESET}")
                        for result in player['recent_results'][:5]:
                            format_label = "1v1" if result['format'] == "1v1" else "Rookies" if result['format'] == "1v1 Rookies" else "2v2"
                            placement_str = f"{result['placement']}{_ordinal(result['placement'])}"
                            date_str = result['date'].strftime('%b %Y')
                            print(f"     {DIM}[{format_label}]{RESET} {format_placement(str(result['placement']))} - {result['tournament'][:40]} {DIM}({date_str}){RESET}")
                else:
                    print(f"  {DIM}No tournament history found{RESET}")


def print_bracket_matchups(seeded_players: List[Dict]) -> None:
    """Print bracket matchups in standard seeding order."""
    n = len(seeded_players)
    
    print_header("BRACKET MATCHUPS (Round 1)")

    matchups = []
    for i in range(n // 2):
        seed1 = i + 1
        seed2 = n - i

        player1 = next((p for p in seeded_players if p['seed'] == seed1), None)
        player2 = next((p for p in seeded_players if p['seed'] == seed2), None)

        if player1 and player2:
            matchups.append((player1, player2))
        elif player1:
            matchups.append((player1, None))

    for i, (p1, p2) in enumerate(matchups, 1):
        print(f"\n{BOLD}{WHITE}Match {i}:{RESET} {format_seed(p1['seed'])} vs {format_seed(p2['seed']) if p2 else 'BYE'}")
        
        p1_indicator = f" {YELLOW}*{RESET}" if p1.get('score_source') == '2v2 (fallback)' else ""
        print(f"  {format_player_name(p1['name'])} ({format_company(p1['company'])}){p1_indicator}")
        
        if p2:
            p2_indicator = f" {YELLOW}*{RESET}" if p2.get('score_source') == '2v2 (fallback)' else ""
            print(f"    {DIM}vs{RESET}")
            print(f"  {format_player_name(p2['name'])} ({format_company(p2['company'])}){p2_indicator}")
        else:
            print(f"    {GREEN}→ advances automatically{RESET}")

    print(f"\n{DIM}Note: * = Player seeded using 2v2 results only (no 1v1 data){RESET}")
