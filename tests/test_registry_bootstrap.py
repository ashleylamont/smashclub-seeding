import csv
import os
import subprocess
import sys

from player_registry import reset_player_registry, write_registry_bootstrap
from glicko_calculator import GlickoCalculator


def test_cached_rows_still_warn_for_unmatched_registry(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    (tmp_path / 'players.yaml').write_text('players: []\n')
    reset_player_registry()

    import json
    os.makedirs('.challonge-cache', exist_ok=True)
    with open('.challonge-cache/testslug.json', 'w') as f:
        json.dump(
            {
                'cache_version': 4,
                'rows': [
                    {'Date': '2025-01-01', 'Tournament': 'T', 'Player 1': 'Unknown One', 'Player 2': 'Unknown Two', 'Winner': 1}
                ],
            },
            f,
        )

    from challonge_import import _load_cached_tournament_rows
    rows = _load_cached_tournament_rows('testslug', verbose=False)

    captured = capsys.readouterr()
    assert rows is not None
    assert 'Unmatched against players.yaml' in captured.out


def test_write_registry_bootstrap_outputs_yaml(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    csv_path = tmp_path / 'matches.csv'
    csv_path.write_text(
        'Date,Tournament,Player 1,Player 2,Winner\n'
        '2025-01-01,Main Weekly,[Atlas] Alpha,[Google] Beta,1\n'
        '2025-01-02,Main Weekly,[Atlas] Gamma,[Google] Beta,1\n'
    )
    calculator = GlickoCalculator(str(csv_path))

    output_path = write_registry_bootstrap(calculator.get_all_players_from_history())

    assert os.path.exists(output_path)
    content = open(output_path).read()
    assert 'canonical_name: Alpha' in content
    assert 'canonical_name: Beta' in content
    assert 'canonical_name: Gamma' in content


def test_main_bootstrap_players_yaml_writes_file(tmp_path):
    matches_csv = tmp_path / 'matches.csv'
    matches_csv.write_text(
        'Date,Tournament,Player 1,Player 2,Winner\n'
        '2025-01-01,Main Weekly,[Atlas] Alpha,[Google] Beta,1\n'
    )

    result = subprocess.run(
        [sys.executable, 'main.py', '--use-glicko', '--matches-csv', str(matches_csv), '--bootstrap-players-yaml'],
        cwd=os.getcwd(),
        capture_output=True,
        text=True,
        check=True,
    )

    assert 'Wrote player registry bootstrap to players.bootstrap.yaml' in result.stdout
    assert os.path.exists('players.bootstrap.yaml')
