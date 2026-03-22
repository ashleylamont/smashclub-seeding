import json
import os
import subprocess
import sys


def test_main_glicko_run_exports_outputs(tmp_path):
    matches_csv = tmp_path / 'matches.csv'
    matches_csv.write_text(
        'Date,Tournament,Player 1,Player 2,Winner\n'
        '2025-01-01,Main Weekly,[Atlas] Alpha,[Google] Beta,1\n'
        '2025-01-02,Main Weekly,[Atlas] Alpha,[Google] Gamma,1\n'
    )
    players_file = tmp_path / 'players.txt'
    players_file.write_text('Alpha [ATL]\n')

    result = subprocess.run(
        [
            sys.executable,
            'main.py',
            '--use-glicko',
            '--matches-csv',
            str(matches_csv),
            '--players',
            str(players_file),
            '--non-interactive',
        ],
        cwd=os.getcwd(),
        capture_output=True,
        text=True,
        check=True,
    )

    assert 'Exported Glicko rankings to' in result.stdout
    assert 'Exported Glicko match history to' in result.stdout
    assert os.path.exists('glicko_exports/glicko_rankings.json')
    assert os.path.exists('glicko_exports/glicko_match_history.csv')

    rankings = json.load(open('glicko_exports/glicko_rankings.json'))
    assert any(row['name'] == 'Alpha' for row in rankings)
