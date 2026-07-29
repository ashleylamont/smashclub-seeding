"""Tests for Challonge import utilities."""

import csv
import os
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import challonge_import
from challonge_import import (
    CHALLONGE_ALIAS_FILE,
    CHALLONGE_ALIAS_VERSION,
    CHALLONGE_CACHE_DIR,
    ChallongeImportError,
    _cache_file_path,
    _canonicalize_rows,
    _warn_if_likely_2v2,
    fetch_tournament_matches,
    fetch_tournaments_matches,
)


class FakeResponse:
    def __init__(self, status_code, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload
        self.text = text
        self.ok = 200 <= status_code < 300

    def json(self):
        return self._payload


def test_warn_if_likely_2v2_flags_team_like_names(capsys):
    _warn_if_likely_2v2(
        'Doubles Weekly',
        [
            'Atlas | Alfred',
            'Canva | Donna',
            'Optiver | Jiamin',
            'Google | Mako',
            'Very Long Team Name One',
            'Very Long Team Name Two',
            'Very Long Team Name Three',
            'Very Long Team Name Four',
        ],
    )

    captured = capsys.readouterr()
    assert 'may be a 2v2/team-format tournament' in captured.out


def test_canonicalize_rows_does_not_warn_on_na_company_alias_in_verbose_mode(capsys):
    rows = [
        {'Date': '2025-01-01', 'Tournament': 'A', 'Player 1': '[ATL] Alfred', 'Player 2': 'Robin', 'Winner': 1},
        {'Date': '2025-01-02', 'Tournament': 'B', 'Player 1': 'Alfred', 'Player 2': 'Lucina', 'Winner': 1},
    ]

    normalized = _canonicalize_rows(rows, interactive=False, verbose=True)

    captured = capsys.readouterr()
    assert "Warning: Similar imported player names detected but kept separate" not in captured.out
    assert normalized[0]['Player 1'] == '[ATL] Alfred'
    assert normalized[1]['Player 1'] == '[ATL] Alfred'


def test_canonicalize_rows_reuses_merge_decision_within_run(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    rows = [
        {'Date': '2025-01-01', 'Tournament': 'A', 'Player 1': '[Atlas] Joshua Loh', 'Player 2': 'Robin', 'Winner': 1},
        {'Date': '2025-01-02', 'Tournament': 'B', 'Player 1': '[Atlas] Josh Loh', 'Player 2': 'Lucina', 'Winner': 1},
        {'Date': '2025-01-03', 'Tournament': 'C', 'Player 1': '[Atlas] Josh Loh', 'Player 2': 'Samus', 'Winner': 1},
    ]

    prompts = []

    def fake_input(prompt):
        prompts.append(prompt)
        return 'y'

    monkeypatch.setattr('builtins.input', fake_input)

    normalized = _canonicalize_rows(rows, interactive=True, verbose=False)

    assert len(prompts) == 1
    assert normalized[1]['Player 1'] == '[ATL] Joshua Loh'
    assert normalized[2]['Player 1'] == '[ATL] Joshua Loh'


def test_canonicalize_rows_reuses_reject_decision_within_run(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    rows = [
        {'Date': '2025-01-01', 'Tournament': 'A', 'Player 1': '[Atlas] Joshua Loh', 'Player 2': 'Robin', 'Winner': 1},
        {'Date': '2025-01-02', 'Tournament': 'B', 'Player 1': '[Atlas] Josh Loh', 'Player 2': 'Lucina', 'Winner': 1},
        {'Date': '2025-01-03', 'Tournament': 'C', 'Player 1': '[Atlas] Josh Loh', 'Player 2': 'Samus', 'Winner': 1},
    ]

    prompts = []

    def fake_input(prompt):
        prompts.append(prompt)
        return 'n'

    monkeypatch.setattr('builtins.input', fake_input)

    normalized = _canonicalize_rows(rows, interactive=True, verbose=False)

    assert len(prompts) == 1
    assert normalized[1]['Player 1'] == '[ATL] Josh Loh'
    assert normalized[2]['Player 1'] == '[ATL] Josh Loh'


def test_canonicalize_rows_persists_alias_decisions_between_runs(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    rows = [
        {'Date': '2025-01-01', 'Tournament': 'A', 'Player 1': '[Atlas] Joshua Loh', 'Player 2': 'Robin', 'Winner': 1},
        {'Date': '2025-01-02', 'Tournament': 'B', 'Player 1': '[Atlas] Josh Loh', 'Player 2': 'Lucina', 'Winner': 1},
    ]

    monkeypatch.setattr('builtins.input', lambda prompt: 'y')
    normalized_first = _canonicalize_rows(rows, interactive=True, verbose=False)
    assert normalized_first[1]['Player 1'] == '[ATL] Joshua Loh'
    assert os.path.exists(CHALLONGE_ALIAS_FILE)

    with open(CHALLONGE_ALIAS_FILE) as f:
        payload = __import__('json').load(f)
    assert payload['version'] == CHALLONGE_ALIAS_VERSION
    assert payload['decisions']

    monkeypatch.setattr('builtins.input', lambda prompt: (_ for _ in ()).throw(AssertionError('should not prompt on second run')))
    normalized_second = _canonicalize_rows(rows, interactive=True, verbose=False)
    assert normalized_second[1]['Player 1'] == '[ATL] Joshua Loh'


def test_canonicalize_rows_reuses_preferred_name_within_run(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    rows = [
        {'Date': '2025-01-01', 'Tournament': 'A', 'Player 1': '[Atlas] Joshua Loh', 'Player 2': 'Robin', 'Winner': 1},
        {'Date': '2025-01-02', 'Tournament': 'B', 'Player 1': '[Atlas] Josh Loh', 'Player 2': 'Lucina', 'Winner': 1},
        {'Date': '2025-01-03', 'Tournament': 'C', 'Player 1': '[Atlas] Josh Loh', 'Player 2': 'Samus', 'Winner': 1},
    ]

    prompts = []

    def fake_input(prompt):
        prompts.append(prompt)
        return '[ATL] Joshualoh'

    monkeypatch.setattr('builtins.input', fake_input)

    normalized = _canonicalize_rows(rows, interactive=True, verbose=False)

    assert len(prompts) == 1
    assert normalized[1]['Player 1'] == '[ATL] Joshualoh'
    assert normalized[2]['Player 1'] == '[ATL] Joshualoh'


def test_fetch_tournament_matches_uses_completed_tournament_cache(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    os.makedirs(CHALLONGE_CACHE_DIR, exist_ok=True)
    cache_path = _cache_file_path('cached_slug')
    with open(cache_path, 'w') as f:
        import json
        json.dump(
            {
                'cache_version': challonge_import.CHALLONGE_CACHE_VERSION,
                'tournament_id': 'cached_slug',
                'source': 'api',
                'completed_at': '2025-03-10T19:00:00Z',
                'rows': [
                    {
                        'Date': '2025-03-10',
                        'Tournament': 'Cached Weekly',
                        'Player 1': '[ATL] Lucina',
                        'Player 2': 'Samus Aran',
                        'Winner': 1,
                    }
                ],
            },
            f,
        )

    def fail_get(url, **kwargs):
        raise AssertionError('network should not be called when cache exists')

    monkeypatch.setattr(challonge_import.requests, 'get', fail_get)
    monkeypatch.setenv('CHALLONGE_USERNAME', 'demo-user')
    monkeypatch.setenv('CHALLONGE_API_KEY', 'demo-key')

    output_csv = tmp_path / 'matches.csv'
    written = fetch_tournament_matches('cached_slug', str(output_csv))

    assert written == 1
    with open(output_csv, newline='') as f:
        rows = list(csv.DictReader(f))
    assert rows[0]['Tournament'] == 'Cached Weekly'


def test_fetch_tournament_matches_writes_completed_rows(monkeypatch, tmp_path):
    monkeypatch.setenv('CHALLONGE_USERNAME', 'demo-user')
    monkeypatch.setenv('CHALLONGE_API_KEY', 'demo-key')

    tournament_payload = {
        'tournament': {
            'name': 'Corporate Smash Weekly',
            'completed_at': '2025-03-10T19:00:00Z',
            'updated_at': '2025-03-10T20:00:00Z',
        }
    }
    participants_payload = [
        {'participant': {'id': 1, 'display_name': '[Atlas]@Lucina'}},
        {'participant': {'id': 2, 'name': 'Samus Aran'}},
        {'participant': {'id': 3, 'display_name': '@Jack Morrison'}},
    ]
    matches_payload = [
        {'match': {'state': 'complete', 'player1_id': 1, 'player2_id': 2, 'winner_id': 1}},
        {'match': {'state': 'pending', 'player1_id': 1, 'player2_id': 3, 'winner_id': None}},
        {'match': {'state': 'complete', 'player1_id': None, 'player2_id': 3, 'winner_id': 3}},
        {'match': {'state': 'complete', 'player1_id': 2, 'player2_id': 3, 'winner_id': 3}},
    ]

    responses = {
        'https://api.challonge.com/v1/tournaments/corporate_weekly.json': FakeResponse(200, tournament_payload),
        'https://api.challonge.com/v1/tournaments/corporate_weekly/participants.json': FakeResponse(200, participants_payload),
        'https://api.challonge.com/v1/tournaments/corporate_weekly/matches.json': FakeResponse(200, matches_payload),
    }

    def fake_get(url, **kwargs):
        assert kwargs['headers'] == challonge_import.CHALLONGE_REQUEST_HEADERS
        assert kwargs['timeout'] == 30
        assert kwargs['auth'] == ('demo-user', 'demo-key')
        return responses[url]

    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(challonge_import.requests, 'get', fake_get)

    output_csv = tmp_path / 'matches.csv'
    written = fetch_tournament_matches('https://challonge.com/corporate_weekly/module', str(output_csv))

    assert written == 2
    assert os.path.exists(_cache_file_path('corporate_weekly'))
    with open(output_csv, newline='') as f:
        rows = list(csv.DictReader(f))

    assert rows == [
        {
            'Date': '2025-03-10',
            'Tournament': 'Corporate Smash Weekly',
            'Player 1': '[ATL] Lucina',
            'Player 2': 'Samus Aran',
            'Winner': '1',
        },
        {
            'Date': '2025-03-10',
            'Tournament': 'Corporate Smash Weekly',
            'Player 1': 'Samus Aran',
            'Player 2': '[ATL] Jack Morrison',
            'Winner': '2',
        },
    ]


def test_fetch_tournament_matches_does_not_cache_incomplete_tournament(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv('CHALLONGE_USERNAME', 'demo-user')
    monkeypatch.setenv('CHALLONGE_API_KEY', 'demo-key')

    tournament_payload = {
        'tournament': {
            'name': 'Ongoing Weekly',
            'state': 'underway',
            'updated_at': '2025-03-10T20:00:00Z',
        }
    }
    participants_payload = [
        {'participant': {'id': 1, 'display_name': '[Atlas]@Lucina'}},
        {'participant': {'id': 2, 'name': 'Samus Aran'}},
    ]
    matches_payload = [
        {'match': {'state': 'complete', 'player1_id': 1, 'player2_id': 2, 'winner_id': 1}},
        {'match': {'state': 'pending', 'player1_id': 1, 'player2_id': 2, 'winner_id': None}},
    ]

    responses = {
        'https://api.challonge.com/v1/tournaments/ongoing_weekly.json': FakeResponse(200, tournament_payload),
        'https://api.challonge.com/v1/tournaments/ongoing_weekly/participants.json': FakeResponse(200, participants_payload),
        'https://api.challonge.com/v1/tournaments/ongoing_weekly/matches.json': FakeResponse(200, matches_payload),
    }

    def fake_get(url, **kwargs):
        return responses[url]

    monkeypatch.setattr(challonge_import.requests, 'get', fake_get)

    output_csv = tmp_path / 'matches.csv'
    written = fetch_tournament_matches('ongoing_weekly', str(output_csv))

    assert written == 1
    assert not os.path.exists(_cache_file_path('ongoing_weekly'))


def test_fetch_tournament_matches_falls_back_to_public_slug_json_on_404(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv('CHALLONGE_USERNAME', 'demo-user')
    monkeypatch.setenv('CHALLONGE_API_KEY', 'demo-key')

    public_payload = {
        'matches_by_round': {
            '1': [
                {
                    'state': 'complete',
                    'underway_at': '2025-08-14T17:49:37.846+10:00',
                    'winner_id': 2,
                    'player1': {'id': 1, 'display_name': '[Atlas]@Lucina'},
                    'player2': {'id': 2, 'display_name': 'Samus Aran'},
                }
            ]
        }
    }

    responses = {
        'https://api.challonge.com/v1/tournaments/techinplace1.json': FakeResponse(404, text='not found'),
        'https://challonge.com/techinplace1.json': FakeResponse(200, public_payload),
    }

    def fake_get(url, **kwargs):
        assert kwargs['headers'] == challonge_import.CHALLONGE_REQUEST_HEADERS
        if url.startswith('https://api.challonge.com/'):
            assert kwargs['auth'] == ('demo-user', 'demo-key')
        else:
            assert 'auth' not in kwargs
        return responses[url]

    monkeypatch.setattr(challonge_import.requests, 'get', fake_get)

    output_csv = tmp_path / 'matches.csv'
    written = fetch_tournament_matches('techinplace1', str(output_csv))

    assert written == 1
    with open(output_csv, newline='') as f:
        rows = list(csv.DictReader(f))

    assert rows == [
        {
            'Date': '2025-08-14',
            'Tournament': 'Tech In Place 1',
            'Player 1': '[ATL] Lucina',
            'Player 2': 'Samus Aran',
            'Winner': '2',
        }
    ]


def test_fetch_tournaments_matches_preserves_input_order(monkeypatch, tmp_path):
    monkeypatch.setenv('CHALLONGE_USERNAME', 'demo-user')
    monkeypatch.setenv('CHALLONGE_API_KEY', 'demo-key')

    responses = {
        'https://api.challonge.com/v1/tournaments/weekly_2.json': FakeResponse(200, {'tournament': {'name': 'Weekly 2', 'completed_at': '2025-03-20T10:00:00Z'}}),
        'https://api.challonge.com/v1/tournaments/weekly_2/participants.json': FakeResponse(200, [
            {'participant': {'id': 1, 'display_name': 'Robin'}},
            {'participant': {'id': 2, 'display_name': 'Lucina'}},
        ]),
        'https://api.challonge.com/v1/tournaments/weekly_2/matches.json': FakeResponse(200, [
            {'match': {'state': 'complete', 'player1_id': 1, 'player2_id': 2, 'winner_id': 2}},
        ]),
        'https://api.challonge.com/v1/tournaments/weekly_1.json': FakeResponse(200, {'tournament': {'name': 'Weekly 1', 'completed_at': '2025-03-10T10:00:00Z'}}),
        'https://api.challonge.com/v1/tournaments/weekly_1/participants.json': FakeResponse(200, [
            {'participant': {'id': 10, 'display_name': 'Samus Aran'}},
            {'participant': {'id': 20, 'display_name': 'Fox McCloud'}},
        ]),
        'https://api.challonge.com/v1/tournaments/weekly_1/matches.json': FakeResponse(200, [
            {'match': {'state': 'complete', 'player1_id': 10, 'player2_id': 20, 'winner_id': 10}},
        ]),
    }

    def fake_get(url, **kwargs):
        assert kwargs['headers'] == challonge_import.CHALLONGE_REQUEST_HEADERS
        assert kwargs['auth'] == ('demo-user', 'demo-key')
        return responses[url]

    monkeypatch.setattr(challonge_import.requests, 'get', fake_get)

    output_csv = tmp_path / 'combined_matches.csv'
    written = fetch_tournaments_matches(['weekly_2', 'weekly_1'], str(output_csv))

    assert written == 2
    with open(output_csv, newline='') as f:
        rows = list(csv.DictReader(f))

    assert rows == [
        {
            'Date': '2025-03-20',
            'Tournament': 'Weekly 2',
            'Player 1': 'Robin',
            'Player 2': 'Lucina',
            'Winner': '2',
        },
        {
            'Date': '2025-03-10',
            'Tournament': 'Weekly 1',
            'Player 1': 'Samus Aran',
            'Player 2': 'Fox McCloud',
            'Winner': '1',
        },
    ]


def test_fetch_tournaments_matches_auto_merges_similar_names(monkeypatch, tmp_path):
    monkeypatch.setenv('CHALLONGE_USERNAME', 'demo-user')
    monkeypatch.setenv('CHALLONGE_API_KEY', 'demo-key')

    responses = {
        'https://api.challonge.com/v1/tournaments/weekly_a.json': FakeResponse(200, {'tournament': {'name': 'Weekly A', 'completed_at': '2025-03-10T10:00:00Z'}}),
        'https://api.challonge.com/v1/tournaments/weekly_a/participants.json': FakeResponse(200, [
            {'participant': {'id': 1, 'display_name': '[Atlas] Joshua Loh'}},
            {'participant': {'id': 2, 'display_name': 'Robin'}},
        ]),
        'https://api.challonge.com/v1/tournaments/weekly_a/matches.json': FakeResponse(200, [
            {'match': {'state': 'complete', 'player1_id': 1, 'player2_id': 2, 'winner_id': 1}},
        ]),
        'https://api.challonge.com/v1/tournaments/weekly_b.json': FakeResponse(200, {'tournament': {'name': 'Weekly B', 'completed_at': '2025-03-12T10:00:00Z'}}),
        'https://api.challonge.com/v1/tournaments/weekly_b/participants.json': FakeResponse(200, [
            {'participant': {'id': 10, 'display_name': '[Atlas] Josh Loh'}},
            {'participant': {'id': 20, 'display_name': 'Lucina'}},
        ]),
        'https://api.challonge.com/v1/tournaments/weekly_b/matches.json': FakeResponse(200, [
            {'match': {'state': 'complete', 'player1_id': 10, 'player2_id': 20, 'winner_id': 10}},
        ]),
    }

    def fake_get(url, **kwargs):
        assert kwargs['headers'] == challonge_import.CHALLONGE_REQUEST_HEADERS
        assert kwargs['auth'] == ('demo-user', 'demo-key')
        return responses[url]

    monkeypatch.setattr(challonge_import.requests, 'get', fake_get)

    output_csv = tmp_path / 'combined_matches.csv'
    written = fetch_tournaments_matches(['weekly_a', 'weekly_b'], str(output_csv), interactive=False, verbose=True)

    assert written == 2
    with open(output_csv, newline='') as f:
        rows = list(csv.DictReader(f))

    assert rows[0]['Player 1'] == '[ATL] Joshua Loh'
    assert rows[1]['Player 1'] == '[ATL] Joshua Loh'


def test_fetch_tournaments_matches_requires_at_least_one_id(tmp_path):
    with pytest.raises(ChallongeImportError, match='At least one Challonge tournament ID or URL is required'):
        fetch_tournaments_matches([], str(tmp_path / 'matches.csv'))


def test_fetch_tournament_matches_raises_for_missing_credentials(monkeypatch, tmp_path):
    monkeypatch.delenv('CHALLONGE_USERNAME', raising=False)
    monkeypatch.delenv('CHALLONGE_API_KEY', raising=False)
    monkeypatch.setattr(challonge_import, 'load_dotenv', lambda: None)

    with pytest.raises(ChallongeImportError, match='Missing Challonge credentials'):
        fetch_tournament_matches('weekly_slug', str(tmp_path / 'matches.csv'))


def test_fetch_tournament_matches_creates_output_directory(monkeypatch, tmp_path):
    monkeypatch.setenv('CHALLONGE_USERNAME', 'demo-user')
    monkeypatch.setenv('CHALLONGE_API_KEY', 'demo-key')

    tournament_payload = {'tournament': {'name': 'Corporate Smash Weekly', 'completed_at': '2025-03-10T19:00:00Z'}}
    participants_payload = [
        {'participant': {'id': 1, 'display_name': '[Atlas]@Lucina'}},
        {'participant': {'id': 2, 'name': 'Samus Aran'}},
    ]
    matches_payload = [
        {'match': {'state': 'complete', 'player1_id': 1, 'player2_id': 2, 'winner_id': 1}},
    ]

    responses = {
        'https://api.challonge.com/v1/tournaments/weekly_slug.json': FakeResponse(200, tournament_payload),
        'https://api.challonge.com/v1/tournaments/weekly_slug/participants.json': FakeResponse(200, participants_payload),
        'https://api.challonge.com/v1/tournaments/weekly_slug/matches.json': FakeResponse(200, matches_payload),
    }

    def fake_get(url, **kwargs):
        return responses[url]

    monkeypatch.setattr(challonge_import.requests, 'get', fake_get)

    output_csv = tmp_path / 'nested' / 'dir' / 'matches.csv'
    written = fetch_tournament_matches('weekly_slug', str(output_csv))

    assert written == 1
    assert output_csv.exists()


def test_fetch_tournaments_matches_continues_when_some_tournaments_fail(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv('CHALLONGE_USERNAME', 'demo-user')
    monkeypatch.setenv('CHALLONGE_API_KEY', 'demo-key')

    responses = {
        'https://api.challonge.com/v1/tournaments/weekly_ok.json': FakeResponse(200, {'tournament': {'name': 'Weekly OK', 'completed_at': '2025-03-10T10:00:00Z'}}),
        'https://api.challonge.com/v1/tournaments/weekly_ok/participants.json': FakeResponse(200, [
            {'participant': {'id': 1, 'display_name': 'Lucina'}},
            {'participant': {'id': 2, 'display_name': 'Robin'}},
        ]),
        'https://api.challonge.com/v1/tournaments/weekly_ok/matches.json': FakeResponse(200, [
            {'match': {'state': 'complete', 'player1_id': 1, 'player2_id': 2, 'winner_id': 1}},
        ]),
        'https://api.challonge.com/v1/tournaments/weekly_bad.json': FakeResponse(520, text='Cloudflare failure'),
    }

    def fake_get(url, **kwargs):
        return responses[url]

    monkeypatch.setattr(challonge_import.requests, 'get', fake_get)

    output_csv = tmp_path / 'combined.csv'
    written = fetch_tournaments_matches(['weekly_ok', 'weekly_bad'], str(output_csv))

    assert written == 1
    with open(output_csv, newline='') as f:
        rows = list(csv.DictReader(f))
    assert len(rows) == 1

    captured = capsys.readouterr()
    assert 'Warning: Some Challonge tournaments could not be imported:' in captured.out
    assert 'weekly_bad:' in captured.out


def test_fetch_tournament_matches_raises_clean_401(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv('CHALLONGE_USERNAME', 'demo-user')
    monkeypatch.setenv('CHALLONGE_API_KEY', 'bad-key')

    def fake_get(url, **kwargs):
        assert kwargs['headers'] == challonge_import.CHALLONGE_REQUEST_HEADERS
        return FakeResponse(401, text='Unauthorized')

    monkeypatch.setattr(challonge_import.requests, 'get', fake_get)

    with pytest.raises(ChallongeImportError, match='401 Unauthorized'):
        fetch_tournament_matches('weekly_slug', str(tmp_path / 'matches.csv'))
