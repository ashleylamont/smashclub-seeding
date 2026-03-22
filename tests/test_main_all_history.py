import os
import subprocess
import sys


def test_main_all_history_players_mode_works_without_players_file(tmp_path):
    matches_csv = tmp_path / 'matches.csv'
    matches_csv.write_text(
        'Date,Tournament,Player 1,Player 2,Winner\n'
        '2025-01-01,Main Weekly,[Atlas] Alpha,[Google] Beta,1\n'
        '2025-01-02,Main Weekly,[Atlas] Gamma,[Google] Beta,1\n'
    )

    result = subprocess.run(
        [
            sys.executable,
            'main.py',
            '--use-glicko',
            '--matches-csv',
            str(matches_csv),
            '--all-history-players',
            '--non-interactive',
        ],
        cwd=os.getcwd(),
        capture_output=True,
        text=True,
        check=True,
    )

    assert 'Processing 3 players...' in result.stdout
    assert 'Seed 1:' in result.stdout
    assert 'Alpha' in result.stdout
    assert 'Beta' in result.stdout
    assert 'Gamma' in result.stdout
