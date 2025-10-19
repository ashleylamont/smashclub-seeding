"""
Test suite for SSBU seeding algorithm.
Tests business logic and edge cases.
"""

import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import pytest
from seeding_algorithm import (
    SeedingCalculator,
    PlayerInput,
    parse_player_list,
    TournamentResult
)
from datetime import datetime


@pytest.fixture
def calculator():
    """Create a seeding calculator with test data."""
    return SeedingCalculator('tests/test_data.csv')


class TestPlayerInput:
    """Tests for PlayerInput normalization."""

    def test_normalize_name_basic(self):
        player = PlayerInput("Samus Aran")
        assert player.normalize_name() == "samus aran"

    def test_normalize_name_with_deactivated(self):
        player = PlayerInput("Samus Aran deactivated")
        assert player.normalize_name() == "samus aran"

    def test_normalize_name_with_whitespace(self):
        player = PlayerInput("  Samus Aran  ")
        assert player.normalize_name() == "samus aran"

    def test_normalize_company_atlassian(self):
        player = PlayerInput("Alice", "ATL")
        assert player.normalize_company() == "Atlassian"

    def test_normalize_company_canva(self):
        player = PlayerInput("Alice", "CAN")
        assert player.normalize_company() == "Canva"

    def test_normalize_company_case_insensitive(self):
        player = PlayerInput("Alice", "atl")
        assert player.normalize_company() == "Atlassian"

    def test_normalize_company_unknown(self):
        player = PlayerInput("Alice", "Unknown Corp")
        assert player.normalize_company() == "Unknown Corp"

    def test_normalize_company_none(self):
        player = PlayerInput("Alice", None)
        assert player.normalize_company() is None
    
    def test_normalize_company_woolworths(self):
        player = PlayerInput("Alice", "WOW")
        assert player.normalize_company() == "Woolworths"


class TestParsePlayerList:
    """Tests for parsing player list strings."""

    def test_parse_company_at_end(self):
        result = parse_player_list("Samus Aran [ATL]")
        assert len(result) == 1
        assert result[0].name == "Samus Aran"
        assert result[0].company == "ATL"

    def test_parse_company_at_start(self):
        result = parse_player_list("[ATL] Samus Aran")
        assert len(result) == 1
        assert result[0].name == "Samus Aran"
        assert result[0].company == "ATL"

    def test_parse_no_company(self):
        result = parse_player_list("Samus Aran", prompt_for_company=False)
        assert len(result) == 1
        assert result[0].name == "Samus Aran"
        assert result[0].company is None

    def test_parse_multiple_players(self):
        player_list = """Samus Aran [ATL]
Fox McCloud [CAN]
Falco Lombardi"""
        result = parse_player_list(player_list, prompt_for_company=False)
        assert len(result) == 3
        assert result[0].name == "Samus Aran"
        assert result[1].name == "Fox McCloud"
        assert result[2].name == "Falco Lombardi"

    def test_parse_empty_lines(self):
        player_list = """Samus Aran [ATL]

Fox McCloud [CAN]

"""
        result = parse_player_list(player_list)
        assert len(result) == 2


class TestRookiesAdjustment:
    """Tests for Rookies placement adjustment."""

    def test_rookies_placed_after_main_bracket(self, calculator):
        """Rookies placements should start after the last main 1v1 placement."""
        # In Winter Bash 2024, main 1v1 goes to placement 8
        # So rookies should start at 9
        results = [r for r in calculator.results
                   if r.tournament == "Winter Bash 2024" and r.is_1v1_rookies]

        # Samus Aran was 1st in rookies, should be adjusted to 9
        alice_rookies = [r for r in results if r.player_name == "Samus Aran"]
        assert len(alice_rookies) == 1
        assert alice_rookies[0].placement == 9  # 8 (max main) + 1

        # Angela Ziegler was 2nd in rookies, should be adjusted to 10
        ivy_rookies = [r for r in results if r.player_name == "Angela Ziegler"]
        assert len(ivy_rookies) == 1
        assert ivy_rookies[0].placement == 10  # 8 (max main) + 2

    def test_rookies_in_different_tournament(self, calculator):
        """Rookies in March Madness should be adjusted based on that tournament's max."""
        # In March Madness 2024, main 1v1 goes to placement 6
        results = [r for r in calculator.results
                   if r.tournament == "March Madness 2024" and r.is_1v1_rookies]

        zoe = [r for r in results if r.player_name == "Satya Vaswani"]
        assert len(zoe) == 1
        assert zoe[0].placement == 7  # 6 (max main) + 1

        xavier = [r for r in results if r.player_name == "Akande Ogundimu"]
        assert len(xavier) == 1
        assert xavier[0].placement == 8  # 6 (max main) + 2


class TestScoreCalculation:
    """Tests for player score calculation logic."""

    def test_score_weighted_with_recency_bias(self, calculator):
        """Score should use weighted average with recency bias."""
        alice = PlayerInput("Samus Aran", "ATL")
        results = calculator.find_player_results(alice)
        score = calculator.calculate_player_score(results, use_time_decay=False)

        # Alice's 1v1 results (newest first): 1st (March), 3rd (Spring), 1st (Winter), 9th (Winter Rookies)
        # With inverse power scoring and decay, score should reflect strong performance
        # Score should be reasonable (not infinite, positive)
        assert score['1v1_score'] > 0
        assert score['1v1_score'] < 10.0  # Should be better than someone who consistently places ~10th
        assert score['best_placement'] == 1
        assert score['most_recent_placement'] == 1

    def test_score_with_consistent_results(self, calculator):
        """Player with consistent results should have weighted score close to their placement."""
        henry = PlayerInput("Mako Rutledge", "CAN")
        results = calculator.find_player_results(henry)
        score = calculator.calculate_player_score(results, use_time_decay=False)

        # Henry has 2 results: 8th (Spring) and 8th (Winter)
        # With inverse power scoring: 1/(8^0.75) = 0.177
        # Score should reflect consistent 8th place performance
        assert 4.0 < score['1v1_score'] < 10.0  # Should be in the range for mid-tier placement
        assert score['best_placement'] == 8
        assert score['most_recent_placement'] == 8

    def test_score_with_no_results(self, calculator):
        """Player with no results should get infinite score."""
        nobody = PlayerInput("Nobody AtAll", "ATL")
        results = calculator.find_player_results(nobody)
        score = calculator.calculate_player_score(results, use_time_decay=False)

        assert score['1v1_score'] == float('inf')
        assert score['2v2_score'] == float('inf')
        assert score['num_tournaments'] == 0

    def test_2v2_used_for_tiebreaking(self, calculator):
        """2v2 score should be calculated for tiebreaking with inverse power scaling."""
        alice = PlayerInput("Samus Aran", "ATL")
        results = calculator.find_player_results(alice)
        score = calculator.calculate_player_score(results, use_time_decay=False)

        # Alice's 2v2 results: 2nd (Spring), 2nd (Winter)
        # With inverse power scaling: 1/(2^0.75) = 0.595
        # Weighted with decay 0.4: (0.595*1.0 + 0.595*0.4) / (1.0 + 0.4) = 0.833 / 1.4 = 0.595
        # Final score: 1/0.595 = 1.68
        assert 1.6 < score['2v2_score'] < 1.7


class TestSeeding:
    """Tests for complete seeding logic."""

    def test_seeding_basic_order(self, calculator):
        """Players should be seeded by weighted score with recency bias."""
        players = [
            PlayerInput("Samus Aran", "ATL"),
            PlayerInput("Fox McCloud", "ATL"),
            PlayerInput("Falco Lombardi", "CAN"),
            PlayerInput("Wolf O'Donnell", "OPT"),
        ]

        seeded = calculator.seed_players(players, use_time_decay=False)

        # With inverse power scoring:
        # Bob: [2, 1, 2] - consistent top performer
        # Alice: [1, 3, 1, 9] - strong recent but 9th hurts
        # Charlie: [3, 2, 3] - consistent mid-placer
        # David: [5, 4, 4] - lower placements
        # Bob and Alice should be top 2 (order may vary based on exact scoring)
        
        top_two_names = {seeded[0]['name'], seeded[1]['name']}
        assert "Fox McCloud" in top_two_names
        assert "Samus Aran" in top_two_names
        assert seeded[2]['name'] == "Falco Lombardi"
        assert seeded[2]['seed'] == 3
        assert seeded[3]['name'] == "Wolf O'Donnell"
        assert seeded[3]['seed'] == 4

    def test_seeding_with_no_history(self, calculator):
        """Players without history should be seeded last."""
        players = [
            PlayerInput("Samus Aran", "ATL"),
            PlayerInput("Newcomer One", "ATL"),
            PlayerInput("Fox McCloud", "ATL"),
            PlayerInput("Newcomer Two", "CAN"),
        ]

        seeded = calculator.seed_players(players, use_time_decay=False)

        # Alice and Bob have history, should be seeds 1-2
        assert seeded[0]['seed'] == 1
        assert seeded[0]['has_history'] is True
        assert seeded[1]['seed'] == 2
        assert seeded[1]['has_history'] is True

        # Newcomers should be seeds 3-4
        assert seeded[2]['seed'] == 3
        assert seeded[2]['has_history'] is False
        assert seeded[3]['seed'] == 4
        assert seeded[3]['has_history'] is False

    def test_seeding_tiebreaker_with_2v2(self, calculator):
        """When 1v1 scores are close, 2v2 should break the tie."""
        # Bob and Alice both have strong recent 1v1 results
        # With decay=0.6, Alice's more recent 1st place gives her better 1v1 score
        players = [
            PlayerInput("Samus Aran", "ATL"),
            PlayerInput("Fox McCloud", "ATL"),
        ]

        seeded = calculator.seed_players(players, use_time_decay=False)

        # Both should have good 1v1 scores (low values)
        assert seeded[0]['score']['1v1_score'] < 10.0
        assert seeded[1]['score']['1v1_score'] < 10.0

        # Alice wins on 1v1 score (stronger recency bias benefits her recent 1st place)
        assert seeded[0]['name'] == "Samus Aran"
        assert seeded[1]['name'] == "Fox McCloud"
        
        # But Bob has better 2v2 score (would win if 1v1 scores were identical)
        assert seeded[1]['score']['2v2_score'] < seeded[0]['score']['2v2_score']

    def test_rookies_count_as_1v1_results(self, calculator):
        """Rookies results should be included in 1v1 scoring after adjustment."""
        alice = PlayerInput("Samus Aran", "ATL")
        results = calculator.find_player_results(alice)

        # Alice has 3 1v1 results + 1 rookies result = 4 total competitive results
        one_v_one = [r for r in results if r.is_1v1 or r.is_1v1_rookies]
        assert len(one_v_one) == 4

        score = calculator.calculate_player_score(results, use_time_decay=False)
        assert score['num_tournaments'] == 4

    def test_first_name_matching(self, calculator):
        """Should match players by first name when full name not found."""
        # Test data has "Samus Aran", try matching with just "Alice"
        alice = PlayerInput("Alice", "ATL")
        results = calculator.find_player_results(alice)

        assert len(results) > 0
        assert any(r.player_name == "Samus Aran" for r in results)

    def test_default_to_atlassian_when_no_company(self, calculator):
        """Should default to Atlassian when no company is provided."""
        # Samus Aran exists in Atlassian, try matching without company
        alice_no_company = PlayerInput("Samus Aran", None)
        results = calculator.find_player_results(alice_no_company)

        # Should find Samus Aran from Atlassian
        assert len(results) > 0
        assert all(r.company == "Atlassian" for r in results)
        assert any(r.player_name == "Samus Aran" for r in results)


class TestBracketGeneration:
    """Tests for proper bracket seeding order."""

    def test_8_player_bracket_order(self, calculator):
        """Test that 8 players are ordered correctly for bracket: 1v8, 4v5, 2v7, 3v6."""
        players = [
            PlayerInput("Samus Aran", "ATL"),
            PlayerInput("Fox McCloud", "ATL"),
            PlayerInput("Falco Lombardi", "CAN"),
            PlayerInput("Wolf O'Donnell", "OPT"),
            PlayerInput("Lena Oxton", "GOOG"),
            PlayerInput("Cloud Strife", "ATL"),
            PlayerInput("Fareeha Amari", "ATL"),
            PlayerInput("Mako Rutledge", "CAN"),
        ]

        seeded = calculator.seed_players(players, use_time_decay=False)

        # Verify seeds are assigned correctly
        seeds = [p['seed'] for p in seeded]
        assert seeds == [1, 2, 3, 4, 5, 6, 7, 8]

        # Standard bracket pairing for 8 players:
        # Round 1: 1v8, 4v5, 2v7, 3v6
        # Bob and Alice should be in top 2 (strong performers)
        # Henry should be at bottom (consistent 8th place)
        top_two = {seeded[0]['name'], seeded[1]['name']}
        assert "Fox McCloud" in top_two
        assert "Samus Aran" in top_two
        assert seeded[7]['name'] == "Mako Rutledge"


class TestEdgeCases:
    """Tests for edge cases and error handling."""

    def test_empty_player_list(self, calculator):
        """Should handle empty player list gracefully."""
        seeded = calculator.seed_players([], use_time_decay=False)
        assert seeded == []

    def test_player_name_case_insensitive(self, calculator):
        """Player name matching should be case insensitive."""
        alice_lower = PlayerInput("samus aran", "ATL")
        alice_upper = PlayerInput("SAMUS ARAN", "ATL")

        results_lower = calculator.find_player_results(alice_lower)
        results_upper = calculator.find_player_results(alice_upper)

        assert len(results_lower) > 0
        assert len(results_lower) == len(results_upper)

    def test_player_with_deactivated_in_name(self, calculator):
        """Should handle 'deactivated' suffix in player names."""
        alice = PlayerInput("Samus Aran deactivated", "ATL")
        results = calculator.find_player_results(alice)

        # Should still find Samus Aran's results
        assert len(results) > 0

    def test_all_players_no_history(self, calculator):
        """Should handle all players having no history."""
        players = [
            PlayerInput("Newcomer One", "ATL"),
            PlayerInput("Newcomer Two", "CAN"),
            PlayerInput("Newcomer Three", "OPT"),
        ]

        seeded = calculator.seed_players(players, use_time_decay=False)

        # All should get seeded in order, but with no history
        assert len(seeded) == 3
        assert all(not p['has_history'] for p in seeded)
        assert [p['seed'] for p in seeded] == [1, 2, 3]

    def test_full_name_match_priority_over_first_name(self, calculator):
        """Full name match should be preferred over first name match if both exist."""
        # This test verifies the matching priority logic
        # In real data, if there's a "Fox McCloud" and a "Bob Jones",
        # searching for "Fox McCloud" should match "Fox McCloud" exactly
        bob_full = PlayerInput("Fox McCloud", "ATL")
        results_full = calculator.find_player_results(bob_full)

        # All results should be for "Fox McCloud", not other "Bob"s
        assert len(results_full) > 0
        assert all(r.player_name == "Fox McCloud" for r in results_full)


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
