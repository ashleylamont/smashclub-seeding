"""
SSBU Tournament Seeding Tool

Command-line tool for seeding Super Smash Bros Ultimate tournament players
based on their historical performance.
"""

import argparse
import sys

from seeding_algorithm import SeedingCalculator, parse_player_list, smart_parse_player_list
from output import print_seeding_results, print_bracket_matchups


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
