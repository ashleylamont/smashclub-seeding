"""
SSBU Tournament Seeding Tool

Command-line tool for seeding Super Smash Bros Ultimate tournament players
based on either historical tournament placements or a Glicko-2 prototype
that uses match-level history.
"""

import argparse
import os
import sys
import tempfile
from typing import List

from challonge_import import ChallongeImportError, fetch_tournament_matches, fetch_tournaments_matches
from glicko_calculator import GlickoCalculator
from output import print_bracket_matchups, print_seeding_results
from player_registry import write_registry_bootstrap
from seeding_algorithm import PlayerInput, SeedingCalculator, parse_player_list, smart_parse_player_list


DEFAULT_CHALLONGE_SOURCES_FILE = "challonge_tournaments.txt"


def _load_challonge_sources_file(file_path: str) -> List[str]:
    """Load Challonge tournament IDs/URLs from a text file.

    Format:
    - one tournament slug or URL per line
    - blank lines are ignored
    - lines starting with # are treated as comments
    """
    sources: List[str] = []
    with open(file_path, "r") as f:
        for raw_line in f:
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            sources.append(line)
    return sources


def _get_default_challonge_sources_file(explicit_file_path: str | None) -> str | None:
    """Return the explicit config file, or the default one if it exists."""
    if explicit_file_path:
        return explicit_file_path
    if os.path.exists(DEFAULT_CHALLONGE_SOURCES_FILE):
        return DEFAULT_CHALLONGE_SOURCES_FILE
    return None


def _resolve_challonge_sources(cli_sources: List[str] | None, file_path: str | None) -> List[str]:
    """Combine Challonge sources from CLI and an optional config file."""
    resolved: List[str] = []
    if file_path:
        resolved.extend(_load_challonge_sources_file(file_path))
    if cli_sources:
        resolved.extend(source.strip() for source in cli_sources if source and source.strip())
    return resolved


def main():
    parser = argparse.ArgumentParser(
        description="SSBU Tournament Seeding Tool",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Seed players from placement history (with smart parsing and fuzzy matching)
  python main.py --csv results.csv --players players.txt
  
  # Seed players with interactive input
  python main.py --csv results.csv --interactive
  
  # Prototype: seed players from match history using Glicko-2
  python main.py --use-glicko --matches-csv matches.csv --players players.txt
  
  # Prototype: fetch match history directly from Challonge into Glicko-2
  python main.py --use-glicko --fetch-challonge my_tournament --players players.txt

  # Prototype: combine multiple Challonge tournaments into one Glicko-2 dataset
  python main.py --use-glicko --fetch-challonge weekly1 weekly2 https://challonge.com/monthly_finals --players players.txt

  # Prototype: load Challonge tournaments from a config file
  python main.py --use-glicko --fetch-challonge-file challonge_tournaments.txt --players players.txt
  
  # Show detailed scoring information and bracket
  python main.py --csv results.csv --players players.txt --details --bracket

  # Seed every player found in the loaded historical data
  python main.py --use-glicko --all-history-players
  
  # Non-interactive mode (no prompts, use defaults)
  python main.py --csv results.csv --players players.txt --non-interactive
  
  # Disable smart parsing (basic mode, no fuzzy matching)
  python main.py --csv results.csv --players players.txt --no-smart-parse
        """,
    )

    parser.add_argument(
        "--csv",
        help="Path to CSV file with historical tournament placement results",
    )
    parser.add_argument(
        "--use-glicko",
        action="store_true",
        help="Use the Glicko-2 prototype with match-level data instead of placement-based seeding",
    )
    parser.add_argument(
        "--matches-csv",
        help="Path to CSV file with historical match results, or fetch destination when used with --fetch-challonge",
    )
    parser.add_argument(
        "--fetch-challonge",
        nargs="+",
        help="Fetch completed match data from one or more Challonge tournament IDs or URLs (requires --use-glicko)",
    )
    parser.add_argument(
        "--fetch-challonge-file",
        help="Path to a text file containing Challonge tournament IDs/URLs, one per line (requires --use-glicko)",
    )
    parser.add_argument(
        "--players",
        help='Path to text file with player list (one per line, format: "Name [COMPANY]")',
    )
    parser.add_argument(
        "--all-history-players",
        action="store_true",
        help="Seed all unique players found in the loaded historical data instead of reading a player list",
    )
    parser.add_argument(
        "--bootstrap-players-yaml",
        action="store_true",
        help="Write a starter players.bootstrap.yaml from all unique players in the loaded history, then exit",
    )
    parser.add_argument(
        "--interactive",
        action="store_true",
        help="Enter players interactively (one per line, empty line to finish)",
    )
    parser.add_argument(
        "--details",
        action="store_true",
        help="Show detailed scoring information for each player",
    )
    parser.add_argument(
        "--bracket",
        action="store_true",
        help="Show bracket matchups based on seeding",
    )
    parser.add_argument(
        "--no-smart-parse",
        action="store_true",
        help="Disable intelligent parsing and fuzzy matching (use basic parsing)",
    )
    parser.add_argument(
        "--non-interactive",
        action="store_true",
        help="Disable all prompts and confirmations (use defaults)",
    )
    parser.add_argument(
        "--compact",
        action="store_true",
        help="Use compact output format with more horizontal space",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Show detailed player matching information",
    )

    args = parser.parse_args()

    generated_matches_csv = None
    use_default_challonge_file = bool(args.use_glicko and not args.matches_csv and not args.fetch_challonge and not args.fetch_challonge_file)
    challonge_sources_file = _get_default_challonge_sources_file(args.fetch_challonge_file) if use_default_challonge_file or args.fetch_challonge_file else None

    if (args.fetch_challonge or args.fetch_challonge_file) and not args.use_glicko:
        print("Error: --fetch-challonge and --fetch-challonge-file can only be used with --use-glicko", file=sys.stderr)
        parser.print_help()
        sys.exit(1)

    try:
        challonge_sources = _resolve_challonge_sources(args.fetch_challonge, challonge_sources_file)
    except FileNotFoundError:
        missing_file = challonge_sources_file or args.fetch_challonge_file or DEFAULT_CHALLONGE_SOURCES_FILE
        print(f"Error: Could not find Challonge tournament file: {missing_file}", file=sys.stderr)
        sys.exit(1)

    if args.use_glicko:
        if args.csv:
            print("Error: Use --matches-csv instead of --csv when passing --use-glicko", file=sys.stderr)
            sys.exit(1)
        if not args.matches_csv and not challonge_sources:
            print(
                "Error: --matches-csv, --fetch-challonge, or a default challonge_tournaments.txt file is required when using --use-glicko",
                file=sys.stderr,
            )
            parser.print_help()
            sys.exit(1)
    elif not args.csv:
        print("Error: --csv is required unless --use-glicko is specified", file=sys.stderr)
        parser.print_help()
        sys.exit(1)

    try:
        matches_csv_path = args.matches_csv
        if args.use_glicko and challonge_sources:
            if not matches_csv_path:
                temp_file = tempfile.NamedTemporaryFile(
                    mode="w",
                    suffix="_matches.csv",
                    prefix="tmp_rovodev_",
                    delete=False,
                )
                temp_file.close()
                matches_csv_path = temp_file.name
                generated_matches_csv = temp_file.name

            source_summary = ", ".join(challonge_sources)
            print(f"Fetching completed Challonge matches from {source_summary}...")
            if len(challonge_sources) == 1:
                imported_count = fetch_tournament_matches(
                    challonge_sources[0],
                    matches_csv_path,
                    interactive=not args.non_interactive,
                    verbose=args.verbose,
                )
            else:
                imported_count = fetch_tournaments_matches(
                    challonge_sources,
                    matches_csv_path,
                    interactive=not args.non_interactive,
                    verbose=args.verbose,
                )
            print(f"Imported {imported_count} completed 1v1 matches into {matches_csv_path}")

        if args.use_glicko:
            calculator = GlickoCalculator(matches_csv_path)
            print(f"Loaded {len(calculator.results) // 2} match results from {matches_csv_path}")
        else:
            calculator = SeedingCalculator(args.csv)
            print(f"Loaded {len(calculator.results)} tournament results from {args.csv}")
    except FileNotFoundError:
        missing_path = matches_csv_path if args.use_glicko else args.csv
        print(f"Error: Could not find CSV file: {missing_path}", file=sys.stderr)
        sys.exit(1)
    except ChallongeImportError as e:
        print(f"Error importing Challonge tournament data: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error loading CSV file: {e}", file=sys.stderr)
        sys.exit(1)

    if args.bootstrap_players_yaml:
        bootstrap_path = write_registry_bootstrap(calculator.get_all_players_from_history())
        print(f"Wrote player registry bootstrap to {bootstrap_path}")
        return

    players_str = None
    if args.all_history_players:
        if args.use_glicko:
            updated = calculator.review_historical_identity_candidates(
                interactive=not args.non_interactive,
                verbose=args.verbose,
            )
            if updated:
                calculator = GlickoCalculator(matches_csv_path)
        players = calculator.get_all_players_from_history()
    else:
        if args.players:
            try:
                with open(args.players, "r") as f:
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
            players_str = "\n".join(lines)
        else:
            print("Error: Must specify --all-history-players, --players, or --interactive", file=sys.stderr)
            parser.print_help()
            sys.exit(1)

        if args.no_smart_parse:
            players = parse_player_list(players_str, prompt_for_company=not args.non_interactive)
        else:
            players = smart_parse_player_list(
                players_str,
                calculator=calculator,
                interactive=not args.non_interactive,
                verbose=args.verbose,
            )

    try:

        if not players:
            print("Error: No players found", file=sys.stderr)
            sys.exit(1)

        print(f"Processing {len(players)} players...")

        if args.use_glicko and not args.all_history_players:
            calculator.review_player_alias_candidates(
                players,
                interactive=not args.non_interactive,
                verbose=args.verbose,
            )

        if args.verbose:
            print("\n" + "=" * 80)
            print("PLAYER MATCHING DETAILS")
            print("=" * 80)

        seeded = calculator.seed_players(players, verbose=args.verbose, interactive=not args.non_interactive)

        if args.use_glicko:
            export_paths = calculator.export_default_outputs(seeded)
            print(f"Exported Glicko rankings to {export_paths['rankings']}")
            print(f"Exported Glicko match history to {export_paths['history']}")

        if args.verbose:
            print("=" * 80)

        if args.details:
            for player_info in seeded:
                player = PlayerInput(player_info["name"], player_info["company"])
                results = calculator.find_player_results(player, verbose=False, interactive=False)
                if not results:
                    continue

                if args.use_glicko:
                    all_results = sorted(results, key=lambda result: result.processing_index, reverse=True)
                    player_info["recent_results"] = [
                        {
                            "format": result.format,
                            "tournament": result.tournament,
                            "date": result.date,
                            "opponent": result.opponent_name,
                            "outcome": "W" if result.won else "L",
                            "pre_rating": result.pre_rating,
                            "post_rating": result.post_rating,
                            "pre_rd": result.pre_rd,
                            "post_rd": result.post_rd,
                            "pre_volatility": result.pre_volatility,
                            "post_volatility": result.post_volatility,
                            "processing_index": result.processing_index,
                        }
                        for result in all_results[:5]
                    ]
                else:
                    all_results = sorted(results, key=lambda result: result.date, reverse=True)
                    player_info["recent_results"] = [
                        {
                            "placement": result.placement,
                            "format": result.format,
                            "tournament": result.tournament,
                            "date": result.date,
                        }
                        for result in all_results[:5]
                    ]

        print_seeding_results(
            seeded,
            show_details=args.details,
            calculator=calculator,
            compact=args.compact,
            verbose=args.verbose,
        )

        if args.bracket:
            print_bracket_matchups(seeded)

    except Exception as e:
        print(f"Error processing players: {e}", file=sys.stderr)
        import traceback

        traceback.print_exc()
        sys.exit(1)
    finally:
        if generated_matches_csv and os.path.exists(generated_matches_csv):
            os.unlink(generated_matches_csv)


if __name__ == "__main__":
    main()
