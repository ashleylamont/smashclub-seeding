import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from challonge_import import _canonicalize_rows
from glicko_calculator import GlickoCalculator
from player_registry import reset_player_registry
from seeding_algorithm import PlayerInput


def test_challonge_canonicalize_rows_uses_players_yaml_and_warns_for_unmatched(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    (tmp_path / 'players.yaml').write_text(
        'players:\n'
        '  - id: jackson-lin\n'
        '    canonical_name: Jackson Lin\n'
        '    company: Atlassian\n'
        '    aliases:\n'
        '      - Jackson\n'
    )
    reset_player_registry()

    rows = [
        {'Date': '2025-01-01', 'Tournament': 'A', 'Player 1': 'Jackson', 'Player 2': 'Unknown Person', 'Winner': 1},
    ]
    normalized = _canonicalize_rows(rows, interactive=False, verbose=False)

    captured = capsys.readouterr()
    assert normalized[0]['Player 1'] == '[ATL] Jackson Lin'
    assert 'Unmatched against players.yaml' in captured.out
    assert 'Unknown Person' in captured.out


def test_glicko_find_player_results_uses_players_yaml_for_query_resolution(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / 'players.yaml').write_text(
        'players:\n'
        '  - id: jackson-lin\n'
        '    canonical_name: Jackson Lin\n'
        '    company: Atlassian\n'
        '    aliases:\n'
        '      - Jackson\n'
    )
    reset_player_registry()

    csv_path = tmp_path / 'matches.csv'
    csv_path.write_text(
        'Date,Tournament,Player 1,Player 2,Winner\n'
        '2025-01-01,Main Weekly,[Atlas] Jackson,[Google] Alpha,1\n'
    )
    calculator = GlickoCalculator(str(csv_path))

    results = calculator.find_player_results(PlayerInput('Jackson Lin', 'ATL'), interactive=False)

    assert len(results) == 1
    assert results[0].player_name == 'Jackson Lin'
