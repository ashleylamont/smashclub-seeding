import json
import os
import subprocess
import sys


def test_main_all_history_mode_reviews_and_rebuilds_before_export(tmp_path):
    matches_csv = tmp_path / 'matches.csv'
    matches_csv.write_text(
        'Date,Tournament,Player 1,Player 2,Winner\n'
        '2025-01-01,Main Weekly,[Atlas] Jackson,[Google] Alpha,1\n'
        '2025-01-02,Main Weekly,[Atlas] Jackson Lin,[Google] Beta,1\n'
    )

    result = subprocess.run(
        [
            sys.executable,
            'main.py',
            '--use-glicko',
            '--matches-csv',
            str(matches_csv),
            '--all-history-players',
        ],
        cwd=os.getcwd(),
        input='2\n',
        capture_output=True,
        text=True,
        check=True,
    )

    assert 'Processing 3 players...' in result.stdout
    rankings = json.load(open('glicko_exports/glicko_rankings.json'))
    names = [row['name'] for row in rankings]
    assert 'Jackson Lin' in names
    assert 'Jackson' not in names
    assert 'Alpha' in names
    assert 'Beta' in names
