import csv
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from challonge_import import fetch_tournaments_matches
from glicko_calculator import GlickoCalculator
from seeding_algorithm import PlayerInput
import challonge_import


class FakeResponse:
    def __init__(self, status_code, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload
        self.text = text
        self.ok = 200 <= status_code < 300

    def json(self):
        return self._payload


def test_fetch_tournaments_preserves_input_tournament_order(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv('CHALLONGE_USERNAME', 'demo-user')
    monkeypatch.setenv('CHALLONGE_API_KEY', 'demo-key')

    responses = {
        'https://api.challonge.com/v1/tournaments/late.json': FakeResponse(200, {'tournament': {'name': 'Late Event', 'completed_at': '2025-03-20T10:00:00Z'}}),
        'https://api.challonge.com/v1/tournaments/late/participants.json': FakeResponse(200, [
            {'participant': {'id': 1, 'display_name': 'Alpha'}},
            {'participant': {'id': 2, 'display_name': 'Beta'}},
        ]),
        'https://api.challonge.com/v1/tournaments/late/matches.json': FakeResponse(200, [
            {'match': {'state': 'complete', 'player1_id': 1, 'player2_id': 2, 'winner_id': 1}},
        ]),
        'https://api.challonge.com/v1/tournaments/early.json': FakeResponse(200, {'tournament': {'name': 'Early Event', 'completed_at': '2025-01-20T10:00:00Z'}}),
        'https://api.challonge.com/v1/tournaments/early/participants.json': FakeResponse(200, [
            {'participant': {'id': 3, 'display_name': 'Gamma'}},
            {'participant': {'id': 4, 'display_name': 'Delta'}},
        ]),
        'https://api.challonge.com/v1/tournaments/early/matches.json': FakeResponse(200, [
            {'match': {'state': 'complete', 'player1_id': 3, 'player2_id': 4, 'winner_id': 3}},
        ]),
    }

    def fake_get(url, **kwargs):
        return responses[url]

    monkeypatch.setattr(challonge_import.requests, 'get', fake_get)

    output_csv = tmp_path / 'matches.csv'
    fetch_tournaments_matches(['late', 'early'], str(output_csv), interactive=False, verbose=False)

    rows = list(csv.DictReader(open(output_csv)))
    assert [row['Tournament'] for row in rows] == ['Late Event', 'Early Event']


def test_glicko_preserves_csv_processing_order(tmp_path):
    csv_path = tmp_path / 'matches.csv'
    csv_path.write_text(
        'Date,Tournament,Player 1,Player 2,Winner\n'
        '2025-02-01,Tournament B,[ATL] Alpha,[GOOG] Beta,1\n'
        '2025-01-01,Tournament A,[ATL] Alpha,[GOOG] Gamma,2\n'
        '2025-01-01,Tournament A,[GOOG] Gamma,[ATL] Alpha,1\n'
    )

    calculator = GlickoCalculator(str(csv_path))
    results = calculator.find_player_results(PlayerInput('Alpha', 'ATL'), interactive=False)
    ordered = sorted(results, key=lambda result: result.processing_index)

    assert [result.tournament for result in ordered] == ['Tournament B', 'Tournament A', 'Tournament A']
    assert [result.processing_index for result in ordered] == [0, 1, 2]
