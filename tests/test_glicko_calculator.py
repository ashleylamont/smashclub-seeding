"""Tests for the Glicko-2 prototype calculator."""

import csv
import json
import os
import sys

import yaml

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from glicko_calculator import (
    GCLICKO_PLAYER_ALIAS_FILE,
    GCLICKO_PLAYER_ALIAS_VERSION,
    GLICKO_STORED_ALIAS_FILE,
    GLICKO_STORED_ALIAS_VERSION,
    GlickoCalculator,
)
from player_registry import reset_player_registry
from seeding_algorithm import PlayerInput, smart_parse_player_list


TEST_MATCHES_CSV = 'tests/test_matches.csv'


def test_glicko_loads_match_rows_and_player_views():
    calculator = GlickoCalculator(TEST_MATCHES_CSV)

    assert len(calculator.results) == 8
    assert ('Alpha', 'Atlassian') in calculator.players
    assert ('Gamma', 'Atlassian') in calculator.players


def test_glicko_find_player_results_uses_legacy_normalization():
    calculator = GlickoCalculator(TEST_MATCHES_CSV)

    results = calculator.find_player_results(PlayerInput('Mako Rutledge', 'GOOG'), interactive=False)

    assert len(results) == 1
    assert results[0].player_name == 'Mako Rutledge'
    assert results[0].company == 'Google'


def test_glicko_time_decay_increases_rd_for_inactive_players():
    calculator = GlickoCalculator(TEST_MATCHES_CSV)

    alpha_results = calculator.find_player_results(PlayerInput('Alpha', 'ATL'), interactive=False)
    gamma_results = calculator.find_player_results(PlayerInput('Gamma', 'ATL'), interactive=False)

    alpha_score = calculator.calculate_player_score(alpha_results)
    gamma_score = calculator.calculate_player_score(gamma_results)

    assert alpha_score['rd'] > gamma_score['rd']


def test_glicko_seed_players_ranks_by_conservative_rating_descending():
    calculator = GlickoCalculator(TEST_MATCHES_CSV)
    players = [PlayerInput('Alpha', 'ATL'), PlayerInput('Gamma', 'ATL'), PlayerInput('Beta', 'GOOG')]

    seeded = calculator.seed_players(players, interactive=False)

    conservative_scores = [player['score']['conservative_rating'] for player in seeded]
    assert conservative_scores == sorted(conservative_scores, reverse=True)
    assert seeded[-1]['name'] == 'Beta'


def test_smart_parsing_works_with_glicko_calculator():
    calculator = GlickoCalculator(TEST_MATCHES_CSV)

    players = smart_parse_player_list('@Alpha\n[Google] Mako RutledgeGoogle', calculator, interactive=False)

    assert len(players) == 2
    assert players[0].name == 'Alpha'
    assert players[0].company == 'ATL'
    assert players[1].name == 'Mako Rutledge'
    assert players[1].company == 'GOOG'


def test_rookie_only_island_gets_stronger_seeding_penalty():
    calculator = GlickoCalculator('tests/test_glicko_rookies.csv')

    rookie_results = calculator.find_player_results(PlayerInput('Rookie Ace', 'ATL'), interactive=False)
    veteran_results = calculator.find_player_results(PlayerInput('Veteran One', 'ATL'), interactive=False)

    rookie_score = calculator.calculate_player_score(rookie_results)
    veteran_score = calculator.calculate_player_score(veteran_results)

    assert rookie_score['rookie_match_count'] == 3
    assert rookie_score['main_match_count'] == 0
    assert rookie_score['bridge_opponent_count'] == 0
    assert rookie_score['effective_rating'] < rookie_score['rating']
    assert rookie_score['rd'] > rookie_score['raw_rd']
    assert rookie_score['conservative_rating'] < (rookie_score['rating'] - (2 * rookie_score['raw_rd']))
    assert veteran_score['effective_rating'] < veteran_score['rating']
    assert veteran_score['effective_rating'] > 1500.0
    assert rookie_score['conservative_rating'] < veteran_score['conservative_rating']


def test_glicko_find_player_results_does_not_cross_merge_distinct_matthews(tmp_path):
    csv_path = tmp_path / 'matthews.csv'
    csv_path.write_text(
        'Date,Tournament,Player 1,Player 2,Winner\n'
        '2025-01-01,Main Weekly,[Atlas] Matthew Jakeman,[Google] Alpha,1\n'
        '2025-01-02,Main Weekly,[Atlas] Matthew Chen,[Google] Beta,1\n'
        '2025-01-03,Main Weekly,[Atlas] Matthew Kokolich,[Google] Gamma,1\n'
    )
    calculator = GlickoCalculator(str(csv_path))

    jakeman_results = calculator.find_player_results(PlayerInput('Matthew Jakeman', 'ATL'), interactive=False)

    assert len(jakeman_results) == 1
    assert all(result.player_name == 'Matthew Jakeman' for result in jakeman_results)


def test_rookie_only_player_does_not_outrank_established_main_player():
    calculator = GlickoCalculator('tests/test_glicko_kai_ashley.csv')

    kai_results = calculator.find_player_results(PlayerInput('Kai Mashimo', 'ATL'), interactive=False)
    ashley_results = calculator.find_player_results(PlayerInput('Ashley Lamont', 'ATL'), interactive=False)

    kai_score = calculator.calculate_player_score(kai_results)
    ashley_score = calculator.calculate_player_score(ashley_results)

    assert kai_score['main_match_count'] > 0
    assert ashley_score['main_match_count'] == 0
    assert kai_score['conservative_rating'] > ashley_score['conservative_rating']


def test_glicko_find_player_results_does_not_treat_jack_as_jackson(tmp_path):
    csv_path = tmp_path / 'jackson.csv'
    csv_path.write_text(
        'Date,Tournament,Player 1,Player 2,Winner\n'
        '2025-01-01,Main Weekly,[Atlas] Jackson,[Google] Alpha,1\n'
    )
    calculator = GlickoCalculator(str(csv_path))

    jack_results = calculator.find_player_results(PlayerInput('Jack Morrison', 'ATL'), interactive=False)

    assert jack_results == []


def test_glicko_find_player_results_does_not_auto_merge_single_first_name_into_full_name(tmp_path):
    csv_path = tmp_path / 'mitchell.csv'
    csv_path.write_text(
        'Date,Tournament,Player 1,Player 2,Winner\n'
        '2025-01-01,Main Weekly,[Atlas] Mitchell,[Google] Alpha,1\n'
        '2025-01-02,Main Weekly,[Atlas] Mitchell Merry,[Google] Beta,1\n'
    )
    calculator = GlickoCalculator(str(csv_path))

    mitchell_results = calculator.find_player_results(PlayerInput('Mitchell Merry', 'ATL'), interactive=False)

    assert len(mitchell_results) == 1
    assert {result.player_name for result in mitchell_results} == {'Mitchell Merry'}


def test_glicko_find_player_results_does_not_merge_josh_c_into_josh_cortese(tmp_path):
    csv_path = tmp_path / 'josh.csv'
    csv_path.write_text(
        'Date,Tournament,Player 1,Player 2,Winner\n'
        '2025-01-01,Main Weekly,[Atlas] Josh C,[Google] Alpha,1\n'
        '2025-01-02,Main Weekly,[Atlas] Josh Cortese,[Google] Beta,1\n'
    )
    calculator = GlickoCalculator(str(csv_path))

    results = calculator.find_player_results(PlayerInput('Josh Cortese', 'ATL'), interactive=False)

    assert len(results) == 1
    assert {result.player_name for result in results} == {'Josh Cortese'}


def test_glicko_review_player_alias_candidates_suggests_safe_short_forms(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    csv_path = tmp_path / 'players.csv'
    csv_path.write_text(
        'Date,Tournament,Player 1,Player 2,Winner\n'
        '2025-01-01,Main Weekly,[Atlas] Justin,[Google] Alpha,1\n'
        '2025-01-02,Main Weekly,[Atlas] Shirley,[Google] Beta,1\n'
        '2025-01-03,Main Weekly,[Atlas] Udit Samant,[Google] Gamma,1\n'
    )
    calculator = GlickoCalculator(str(csv_path))

    prompts = []
    answers = iter(['1', '1'])

    def fake_input(prompt):
        prompts.append(prompt)
        return next(answers)

    monkeypatch.setattr('builtins.input', fake_input)
    calculator.review_player_alias_candidates(
        [PlayerInput('Justin Tu', 'ATL'), PlayerInput('Shirley Zhou', 'ATL'), PlayerInput('Sam Yin', 'ATL')],
        interactive=True,
        verbose=False,
    )

    assert len(prompts) == 2
    assert 'justin tu::atlassian' in calculator.player_query_aliases
    assert 'shirley zhou::atlassian' in calculator.player_query_aliases
    assert 'sam yin::atlassian' not in calculator.player_query_aliases


def test_glicko_review_player_alias_candidates_persists_between_runs(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    csv_path = tmp_path / 'players.csv'
    csv_path.write_text(
        'Date,Tournament,Player 1,Player 2,Winner\n'
        '2025-01-01,Main Weekly,[Atlas] Justin,[Google] Alpha,1\n'
    )
    calculator = GlickoCalculator(str(csv_path))

    monkeypatch.setattr('builtins.input', lambda prompt: '1')
    calculator.review_player_alias_candidates([PlayerInput('Justin Tu', 'ATL')], interactive=True, verbose=False)

    assert os.path.exists(GCLICKO_PLAYER_ALIAS_FILE)
    with open(GCLICKO_PLAYER_ALIAS_FILE) as f:
        payload = json.load(f)
    assert payload['version'] == GCLICKO_PLAYER_ALIAS_VERSION
    assert payload['aliases']['justin tu::atlassian']['name'] == 'Justin'

    calculator2 = GlickoCalculator(str(csv_path))
    results = calculator2.find_player_results(PlayerInput('Justin Tu', 'ATL'), interactive=False)
    assert len(results) == 1
    assert results[0].player_name == 'Justin'


def test_glicko_seed_players_includes_query_alias_used(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    csv_path = tmp_path / 'players.csv'
    csv_path.write_text(
        'Date,Tournament,Player 1,Player 2,Winner\n'
        '2025-01-01,Main Weekly,[Atlas] Justin,[Google] Alpha,1\n'
    )
    calculator = GlickoCalculator(str(csv_path))
    calculator.player_query_aliases['justin tu::atlassian'] = {'name': 'Justin', 'company': 'Atlassian'}

    seeded = calculator.seed_players([PlayerInput('Justin Tu', 'ATL')], interactive=False)

    assert seeded[0]['query_alias_used'] == {'name': 'Justin', 'company': 'Atlassian'}


def test_glicko_review_historical_identity_candidates_persists_stored_aliases(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    reset_player_registry()
    csv_path = tmp_path / 'players.csv'
    csv_path.write_text(
        'Date,Tournament,Player 1,Player 2,Winner\n'
        '2025-01-01,Main Weekly,[Atlas] Jackson,[Google] Alpha,1\n'
        '2025-01-02,Main Weekly,[Atlas] Jackson Lin,[Google] Beta,1\n'
    )
    calculator = GlickoCalculator(str(csv_path))

    monkeypatch.setattr('builtins.input', lambda prompt: '2')
    updated = calculator.review_historical_identity_candidates(interactive=True, verbose=False)

    assert updated is True
    assert os.path.exists(GLICKO_STORED_ALIAS_FILE)
    with open(GLICKO_STORED_ALIAS_FILE) as f:
        payload = json.load(f)
    assert payload['version'] == GLICKO_STORED_ALIAS_VERSION
    assert payload['aliases']['jackson::atlassian']['name'] == 'Jackson Lin'

    calculator2 = GlickoCalculator(str(csv_path))
    players = calculator2.get_all_players_from_history()
    names = {(player.name, player.company) for player in players}
    assert ('Jackson Lin', 'ATL') in names
    assert ('Jackson', 'ATL') not in names
    assert ('Alpha', 'GOOG') in names
    assert ('Beta', 'GOOG') in names


def test_glicko_exports_rankings_and_history(tmp_path):
    csv_path = tmp_path / 'players.csv'
    csv_path.write_text(
        'Date,Tournament,Player 1,Player 2,Winner\n'
        '2025-01-01,Main Weekly,[Atlas] Alpha,[Google] Beta,1\n'
        '2025-01-02,Main Weekly,[Atlas] Alpha,[Google] Gamma,1\n'
    )
    calculator = GlickoCalculator(str(csv_path))
    seeded = calculator.seed_players([PlayerInput('Alpha', 'ATL')], interactive=False)

    rankings_path = tmp_path / 'rankings.json'
    history_path = tmp_path / 'history.csv'
    calculator.export_rankings(seeded, str(rankings_path))
    calculator.export_match_history(str(history_path))

    assert rankings_path.exists()
    assert history_path.exists()
    rankings = json.load(open(rankings_path))
    assert rankings[0]['name'] == 'Alpha'
    rows = list(csv.DictReader(open(history_path)))
    assert len(rows) == 4
    assert rows[0]['processing_index'] == '0'


def test_glicko_get_all_players_from_history_returns_unique_players():
    calculator = GlickoCalculator(TEST_MATCHES_CSV)

    players = calculator.get_all_players_from_history()

    names = {(player.name, player.company) for player in players}
    assert ('Alpha', 'ATL') in names
    assert ('Gamma', 'ATL') in names
    assert ('Beta', 'GOOG') in names
    assert ('Mako Rutledge', 'GOOG') in names
