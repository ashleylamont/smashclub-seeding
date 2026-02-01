"""
SSBU Tournament Seeding Tool

Command-line tool for seeding Super Smash Bros Ultimate tournament players
based on their historical performance.
"""

import argparse
import sys

from tabulate import tabulate

from seeding_algorithm import SeedingCalculator, parse_player_list, smart_parse_player_list


def _ordinal(n):
    """Convert number to ordinal string (1st, 2nd, 3rd, etc.)."""
    if 10 <= n % 100 <= 20:
        suffix = 'th'
    else:
        suffix = {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')
    return suffix


def print_seeding_results(seeded_players, show_details=False, calculator=None, compact=False, verbose=False):
    """Print seeding results in a formatted way."""

    if compact and show_details:
        # Use tabulate for proper table formatting
        print("\n" + "=" * 80)
        print("TOURNAMENT SEEDING RESULTS")
        print("=" * 80)
        print("\nLegend:")
        print("  Score = Lower is better  |  Trn = Tournaments attended  |  2v2 = Tiebreaker only")
        print("\nTournament Shorthands:")
        if calculator:
            # Display shorthands in a compact format
            shorthands = sorted(calculator.tournament_shorthands.items(), key=lambda x: x[1])
            shorthand_strs = [f"{sh}={name.replace('https://challonge.com/', '')[:30]}" for name, sh in shorthands]
            print("  " + " | ".join(shorthand_strs[:4]))
            if len(shorthand_strs) > 4:
                print("  " + " | ".join(shorthand_strs[4:]))

        # Build table data
        table_data = []
        if verbose:
            headers = ["Seed", "Name", "Co", "Base", "H2H", "Final", "Best", "Recent", "Trn", "Days", "Recent Results"]
        else:
            headers = ["Seed", "Name", "Co", "Score", "Best", "Recent", "Trn", "2v2",
                       "Recent Results (Most Recent First)"]

        for player in seeded_players:
            seed = str(player['seed'])
            name = player['name']
            if len(name) > 22:
                name = name[:19] + "..."
            company = player['company'][:6]

            if player['has_history']:
                score = player['score']

                # Check if using 2v2 fallback
                score_source = player.get('score_source', '1v1')
                if score_source == '2v2 (fallback)':
                    # Display the actual 2v2 score (not the penalty-adjusted primary score)
                    score_val = f"{score['2v2_score']:.2f}*"  # Add asterisk to indicate 2v2
                    best = "-"
                    recent = "-"
                    tournaments = "0"
                    two_v_two = f"{score['2v2_score']:.2f}"
                    # Note: The actual sorting uses primary_score which includes a 100+ penalty
                else:
                    score_val = f"{score['1v1_score']:.2f}"
                    best = f"{score['best_placement']:.0f}"
                    recent = f"{score['most_recent_placement']:.0f}"
                    tournaments = str(score['num_tournaments'])
                    two_v_two = f"{score['2v2_score']:.2f}" if score['2v2_score'] != float('inf') else "-"

                # Format recent results with tournament shorthands (1v1 only)
                recent_str = ""
                if 'recent_results' in player and player['recent_results']:
                    results_parts = []
                    # Filter to only show 1v1 results (2v2 is only for tiebreaking)
                    one_v_one_results = [r for r in player['recent_results'] if r['format'] in ['1v1', '1v1 Rookies']]
                    for i, result in enumerate(one_v_one_results[:3]):  # Show top 3
                        placement = result['placement']
                        date_str = result['date'].strftime('%d %b %y')
                        # Get tournament shorthand
                        tournament_name = result['tournament']
                        shorthand = calculator.tournament_shorthands.get(tournament_name,
                                                                         'UNK') if calculator else 'UNK'
                        results_parts.append(f"{shorthand} {placement}{_ordinal(placement)} {date_str}")
                    recent_str = " | ".join(results_parts)

                if verbose:
                    # Show detailed score breakdown
                    base_score = score['1v1_score'] - player.get('h2h_adjustment', 0)
                    h2h_adj = player.get('h2h_adjustment', 0)
                    final_score = score['1v1_score']

                    # Calculate days since last tournament
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

                    table_data.append([seed, name, company, f"{base_score:.2f}", f"{h2h_adj:+.2f}",
                                       f"{final_score:.2f}", best, recent, tournaments, days_since, recent_str])
                else:
                    table_data.append(
                        [seed, name, company, score_val, best, recent, tournaments, two_v_two, recent_str])
            else:
                if verbose:
                    table_data.append([seed, name, company, 'N/A', '-', 'N/A', '-', '-', '0', 'No tournament history'])
                else:
                    table_data.append([seed, name, company, 'N/A', '-', '-', '0', '-', 'No tournament history'])

        # Print table using tabulate
        print("\n" + tabulate(table_data, headers=headers, tablefmt="heavy_grid"))

        print("\nNote: 'Score' uses inverse power scaling (1/p^0.75) so top placements matter much more.")
        print("      Example: 1st→1.0, 2nd→1.68, 3rd→2.28, 5th→3.34, 9th→5.24, 13th→6.76, 17th→8.20")
        print("      Key: 2nd→3rd difference is much more significant than 13th→17th difference.")
        print("      Peak Placement Bonus: 1st→-2.0, 2nd→-1.27, 3rd→-0.94, 5th→-0.62, 7th→-0.44, 10th→-0.29")
        print("      Recent results strongly prioritized (decay: 0.4^(days/90), ~60 day half-life)")
        print("      'Best' and 'Recent' show raw placement numbers from tournaments.")
        print("      '2v2' score is used as a tiebreaker when 1v1 scores are equal.")
        print("      * = Score based on 2v2 results (no 1v1 data available, ranked near bottom)")

        # Show H2H adjustment details for players with significant adjustments
        if verbose:
            print("\n" + "=" * 80)
            print("HEAD-TO-HEAD ADJUSTMENTS")
            print("=" * 80)
            print("\nHow H2H works: When players compete in the same tournament, those who place")
            print("better than average (among seeded players) get a bonus, worse get a penalty.")
            print("Adjustments scale with placement spread and decay over 60 days (0.6^(days/60)).")
            print("Max adjustment per tournament: ±1.0 per player.")
            print("\nFormat: Name | Total | (biggest contributor: TOURNAMENT ranked X/N among seeded players)")
            print("Note: Rankings are relative to seeded players only (e.g., 1st/4 = best among 4 seeded).")
            print("      Absolute tournament placements don't matter, only rank among seeded players.\n")

            # Filter to players with significant H2H adjustments (>0.1)
            players_with_h2h = [p for p in seeded_players if abs(p.get('h2h_adjustment', 0)) > 0.1]

            if players_with_h2h:
                for player in players_with_h2h:
                    h2h_adj = player.get('h2h_adjustment', 0)
                    h2h_details = player.get('h2h_details', [])

                    if h2h_details:
                        # Sort by absolute adjustment value to get biggest contributor
                        sorted_details = sorted(h2h_details, key=lambda x: abs(x['adjustment']), reverse=True)
                        top_tournament = sorted_details[0]

                        shorthand = calculator.tournament_shorthands.get(top_tournament['tournament'], 'UNK')
                        relative_rank = top_tournament['relative_rank']
                        num_participants = len(top_tournament['participants'])
                        top_adj = top_tournament['adjustment']

                        # Count total tournaments contributing
                        num_tournaments = len(h2h_details)

                        print(
                            f"  {player['name']:20s} {h2h_adj:+.2f}  (biggest: {shorthand} ranked {relative_rank}{_ordinal(relative_rank)}/{num_participants} among seeded = {top_adj:+.2f}, {num_tournaments} total)")
            else:
                print("\nNo significant H2H adjustments (all below ±0.1).")
    else:
        # Original format
        print("\n" + "=" * 80)
        print("TOURNAMENT SEEDING RESULTS")
        print("=" * 80)

        for player in seeded_players:
            print(f"\nSeed {player['seed']}: {player['name']} ({player['company']})")

            if show_details:
                if player['has_history']:
                    score = player['score']
                    print(f"  📊 Weighted Score: {score['1v1_score']:.2f}")
                    if 'peak_bonus' in score and score['peak_bonus'] != 0:
                        print(f"  ⭐ Peak Placement Bonus: {score['peak_bonus']:.1f} (for {score['best_placement']:.0f} place finish)")
                    print(f"  🏆 All-time Best: {score['best_placement']:.0f}")
                    print(f"  🎯 Most Recent: {score['most_recent_placement']:.0f}")
                    print(f"  🎮 Tournaments Attended: {score['num_tournaments']}")
                    if score['2v2_score'] != float('inf'):
                        print(f"  👥 2v2 Score (tiebreaker): {score['2v2_score']:.2f}")

                    # Show recent tournament placements
                    if 'recent_results' in player and player['recent_results']:
                        print(f"  Recent Results:")
                        for result in player['recent_results'][:5]:  # Show up to 5 most recent
                            format_label = "1v1" if result['format'] == "1v1" else "Rookies" if result[
                                                                                                    'format'] == "1v1 Rookies" else "2v2"
                            placement_str = f"{result['placement']}{_ordinal(result['placement'])}"
                            date_str = result['date'].strftime('%b %Y')
                            print(f"     [{format_label}] {placement_str} - {result['tournament']} ({date_str})")
                else:
                    print(f"  No tournament history found")

        print("\n" + "=" * 80)


def print_bracket_matchups(seeded_players):
    """Print bracket matchups in standard seeding order."""
    n = len(seeded_players)
    print("\n" + "=" * 80)
    print("BRACKET MATCHUPS (Round 1)")
    print("=" * 80)

    # Standard bracket pairing: 1v(n), 2v(n-1), etc.
    matchups = []
    for i in range(n // 2):
        seed1 = i + 1
        seed2 = n - i

        player1 = next((p for p in seeded_players if p['seed'] == seed1), None)
        player2 = next((p for p in seeded_players if p['seed'] == seed2), None)

        if player1 and player2:
            matchups.append((player1, player2))
        elif player1:
            matchups.append((player1, None))  # Bye

    for i, (p1, p2) in enumerate(matchups, 1):
        if p2:
            print(f"\nMatch {i}: Seed {p1['seed']} vs Seed {p2['seed']}")
            # Add indicator if player is seeded using 2v2 only
            p1_indicator = " *" if p1.get('score_source') == '2v2 (fallback)' else ""
            p2_indicator = " *" if p2.get('score_source') == '2v2 (fallback)' else ""
            print(f"  {p1['name']} ({p1['company']}){p1_indicator}")
            print(f"    vs")
            print(f"  {p2['name']} ({p2['company']}){p2_indicator}")
        else:
            print(f"\nMatch {i}: Seed {p1['seed']} (BYE)")
            p1_indicator = " *" if p1.get('score_source') == '2v2 (fallback)' else ""
            print(f"  {p1['name']} ({p1['company']}){p1_indicator} advances automatically")

    print("\n" + "=" * 80)
    print("\nNote: * = Player seeded using 2v2 results only (no 1v1 tournament data)")


def main():
    parser = argparse.ArgumentParser(
        description="SSBU Tournament Seeding Tool",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Seed players from a file (with smart parsing and fuzzy matching)
  python main.py --csv results.csv --players players.txt
  
  # Seed players with interactive input
  python main.py --csv results.csv --interactive
  
  # Show detailed scoring information and bracket
  python main.py --csv results.csv --players players.txt --details --bracket
  
  # Non-interactive mode (no prompts, use defaults)
  python main.py --csv results.csv --players players.txt --non-interactive
  
  # Disable smart parsing (basic mode, no fuzzy matching)
  python main.py --csv results.csv --players players.txt --no-smart-parse
        """
    )

    parser.add_argument(
        '--csv',
        required=True,
        help='Path to CSV file with historical tournament results'
    )

    parser.add_argument(
        '--players',
        help='Path to text file with player list (one per line, format: "Name [COMPANY]")'
    )

    parser.add_argument(
        '--interactive',
        action='store_true',
        help='Enter players interactively (one per line, empty line to finish)'
    )

    parser.add_argument(
        '--details',
        action='store_true',
        help='Show detailed scoring information for each player'
    )

    parser.add_argument(
        '--bracket',
        action='store_true',
        help='Show bracket matchups based on seeding'
    )

    parser.add_argument(
        '--no-smart-parse',
        action='store_true',
        help='Disable intelligent parsing and fuzzy matching (use basic parsing)'
    )

    parser.add_argument(
        '--non-interactive',
        action='store_true',
        help='Disable all prompts and confirmations (use defaults)'
    )

    parser.add_argument(
        '--compact',
        action='store_true',
        help='Use compact output format with more horizontal space'
    )

    parser.add_argument(
        '--verbose',
        action='store_true',
        help='Show detailed player matching information'
    )

    args = parser.parse_args()

    # Load the seeding calculator
    try:
        calculator = SeedingCalculator(args.csv)
        print(f"Loaded {len(calculator.results)} tournament results from {args.csv}")
    except FileNotFoundError:
        print(f"Error: Could not find CSV file: {args.csv}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error loading CSV file: {e}", file=sys.stderr)
        sys.exit(1)

    # Get player list
    players_str = None

    if args.players:
        try:
            with open(args.players, 'r') as f:
                players_str = f.read()
        except FileNotFoundError:
            print(f"Error: Could not find players file: {args.players}", file=sys.stderr)
            sys.exit(1)
    elif args.interactive:
        print("\nEnter player names (one per line, format: 'Name [COMPANY]')")
        print("Press Enter twice when done:\n")
        lines = []
        while True:
            line = input()
            if not line:
                break
            lines.append(line)
        players_str = '\n'.join(lines)
    else:
        print("Error: Must specify either --players or --interactive", file=sys.stderr)
        parser.print_help()
        sys.exit(1)

    # Parse and seed players
    try:
        # Use smart parsing by default (with fuzzy matching and prompting)
        if args.no_smart_parse:
            # Basic parsing without fuzzy matching
            players = parse_player_list(players_str, prompt_for_company=not args.non_interactive)
        else:
            # Smart parsing with fuzzy matching and user confirmation
            players = smart_parse_player_list(
                players_str,
                calculator=calculator,
                interactive=not args.non_interactive,
                verbose=args.verbose
            )

        if not players:
            print("Error: No players found", file=sys.stderr)
            sys.exit(1)

        print(f"Processing {len(players)} players...")

        if args.verbose:
            print("\n" + "=" * 80)
            print("PLAYER MATCHING DETAILS")
            print("=" * 80)

        seeded = calculator.seed_players(players, verbose=args.verbose, interactive=not args.non_interactive)

        if args.verbose:
            print("=" * 80)

        # Add recent results to seeded players for display
        if args.details:
            from seeding_algorithm import PlayerInput
            for player_info in seeded:
                player = PlayerInput(player_info['name'], player_info['company'])
                results = calculator.find_player_results(player, verbose=False, interactive=False)
                if results:
                    # Get all results, sorted by date
                    all_results = [r for r in results]
                    all_results.sort(key=lambda x: x.date, reverse=True)
                    player_info['recent_results'] = [
                        {
                            'placement': r.placement,
                            'format': r.format,
                            'tournament': r.tournament,
                            'date': r.date
                        }
                        for r in all_results[:5]  # Keep up to 5 most recent
                    ]

        # Print results
        print_seeding_results(seeded, show_details=args.details, calculator=calculator, compact=args.compact,
                              verbose=args.verbose)

        if args.bracket:
            print_bracket_matchups(seeded)

    except Exception as e:
        print(f"Error processing players: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
