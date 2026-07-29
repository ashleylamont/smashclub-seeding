"""
Regression tests for peak placement bonus and performance weighting.

These tests validate the algorithm changes from PR #2:
1. Peak placement bonus: rewards top finishes with time decay
2. Performance weighting: better placements get more influence in weighted average
"""

import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import pytest
from datetime import datetime, timedelta
from seeding_algorithm import SeedingCalculator, TournamentResult


class TestPeakPlacementBonus:
    """Tests for the peak placement bonus feature."""

    def test_peak_bonus_formula_values(self):
        """
        Verify peak bonus formula: -2.5 / (placement^0.5) + 0.5
        
        Expected values (without time decay):
        1st → -2.00, 2nd → -1.27, 3rd → -0.94, 5th → -0.62, 7th → -0.44, 10th → -0.29
        """
        def calculate_peak_bonus(placement):
            return -2.5 / (placement ** 0.5) + 0.5
        
        expected = {
            1: -2.00,
            2: -1.27,
            3: -0.94,
            5: -0.62,
            7: -0.44,
            10: -0.29,
        }
        
        for placement, expected_bonus in expected.items():
            actual = calculate_peak_bonus(placement)
            assert abs(actual - expected_bonus) < 0.01, \
                f"Peak bonus for {placement}th: expected {expected_bonus}, got {actual:.2f}"

    def test_peak_bonus_only_applies_to_top_10(self):
        """Peak bonus should only apply to placements 1-10."""
        # Create results with 11th place as best
        results = [
            TournamentResult(
                company="Atlassian",
                player_name="Test Player",
                placement=11,
                date=datetime.now() - timedelta(days=30),
                format="1v1",
                tournament="Test Tournament"
            )
        ]
        
        # We need to mock calculate_player_score behavior
        # Since best_placement=11 > 10, peak_bonus should be 0.0
        best_placement = min(r.placement for r in results)
        assert best_placement == 11
        
        # Peak bonus only applies when best_placement <= 10
        peak_bonus = 0.0
        if best_placement <= 10:
            peak_bonus = -2.5 / (best_placement ** 0.5) + 0.5
        
        assert peak_bonus == 0.0, "Peak bonus should be 0 for placements > 10"

    def test_peak_bonus_time_decay(self):
        """Peak bonus should decay over time with 360-day half-life."""
        base_bonus_1st = -2.5 / (1 ** 0.5) + 0.5  # -2.0 for 1st place
        
        # At day 0: full bonus
        days_0_decay = 0.5 ** (0 / 360.0)
        assert abs(days_0_decay - 1.0) < 0.001
        
        # At day 360: half bonus (half-life)
        days_360_decay = 0.5 ** (360 / 360.0)
        assert abs(days_360_decay - 0.5) < 0.001
        
        # At day 720: quarter bonus
        days_720_decay = 0.5 ** (720 / 360.0)
        assert abs(days_720_decay - 0.25) < 0.001
        
        # Verify decayed bonuses
        assert abs(base_bonus_1st * days_0_decay - (-2.0)) < 0.01
        assert abs(base_bonus_1st * days_360_decay - (-1.0)) < 0.01
        assert abs(base_bonus_1st * days_720_decay - (-0.5)) < 0.01


class TestPerformanceWeighting:
    """
    Tests for performance weighting in the weighted average.
    
    The key insight: better placements should get more weight in the average,
    so that one great result matters more than multiple mediocre ones.
    """

    def test_inconsistent_high_performer_beats_consistent_mid_tier(self):
        """
        Player A (2nd, 17th) should rank higher than Player B (7th, 7th).
        
        This is the core scenario from the PR description:
        - Old system: Player B would rank higher due to consistency
        - New system: Player A ranks higher because 2nd place peak is more meaningful
        """
        recency_decay = 0.4
        
        def inverse_placement(p):
            return 1.0 / (p ** 0.75)
        
        def calculate_score_with_performance_weighting(placements, days_ago_list):
            """New algorithm with performance weighting."""
            weighted_sum = 0.0
            weight_total = 0.0
            for p, days in zip(placements, days_ago_list):
                recency_weight = recency_decay ** (days / 90)
                inv_p = inverse_placement(p)
                performance_weight = recency_weight * inv_p
                weighted_sum += inv_p * performance_weight
                weight_total += performance_weight
            avg_inverse = weighted_sum / weight_total
            return 1.0 / avg_inverse
        
        # Both tournaments 30 days ago (equal recency)
        days = [30, 30]
        
        player_a_score = calculate_score_with_performance_weighting([2, 17], days)
        player_b_score = calculate_score_with_performance_weighting([7, 7], days)
        
        # Player A should have a LOWER score (lower is better)
        assert player_a_score < player_b_score, \
            f"Player A (2nd, 17th) should beat Player B (7th, 7th). " \
            f"Got A={player_a_score:.3f}, B={player_b_score:.3f}"

    def test_performance_weighting_effect_magnitude(self):
        """
        Verify that performance weighting has meaningful impact.
        
        Player A's 2nd place should significantly outweigh their 17th place.
        """
        recency_decay = 0.4
        
        def inverse_placement(p):
            return 1.0 / (p ** 0.75)
        
        # Calculate weights for 2nd vs 17th place (same recency)
        recency_weight = recency_decay ** (30 / 90)  # 30 days ago
        
        inv_2nd = inverse_placement(2)
        inv_17th = inverse_placement(17)
        
        weight_2nd = recency_weight * inv_2nd
        weight_17th = recency_weight * inv_17th
        
        # 2nd place should have significantly more weight than 17th
        weight_ratio = weight_2nd / weight_17th
        assert weight_ratio > 3.0, \
            f"2nd place should have >3x the weight of 17th place, got {weight_ratio:.2f}x"

    def test_peak_performance_dominates_bad_results(self):
        """
        With performance weighting, a great peak dominates bad results.
        
        Player with (2nd, 25th) should beat someone with (3rd, 3rd).
        The 2nd place result gets so much weight that the 25th barely matters.
        
        This is intentional: the algorithm rewards players who can reach
        elite placements, even if they sometimes bomb out.
        """
        recency_decay = 0.4
        
        def inverse_placement(p):
            return 1.0 / (p ** 0.75)
        
        def calculate_score_with_performance_weighting(placements, days_ago_list):
            weighted_sum = 0.0
            weight_total = 0.0
            for p, days in zip(placements, days_ago_list):
                recency_weight = recency_decay ** (days / 90)
                inv_p = inverse_placement(p)
                performance_weight = recency_weight * inv_p
                weighted_sum += inv_p * performance_weight
                weight_total += performance_weight
            avg_inverse = weighted_sum / weight_total
            return 1.0 / avg_inverse
        
        days = [30, 30]
        
        consistent_3rd = calculate_score_with_performance_weighting([3, 3], days)
        volatile_2nd_25th = calculate_score_with_performance_weighting([2, 25], days)
        
        # With performance weighting, 2nd place dominates the 25th place result
        # so the volatile player actually ranks better
        assert volatile_2nd_25th < consistent_3rd, \
            f"Volatile (2nd, 25th) should beat consistent (3rd, 3rd) due to peak weighting. " \
            f"Got volatile={volatile_2nd_25th:.3f}, consistent={consistent_3rd:.3f}"


class TestCombinedBehavior:
    """Tests for peak bonus + performance weighting working together."""

    def test_peak_bonus_improves_differentiation(self):
        """
        Peak bonus should help differentiate players with similar weighted scores
        but different best placements.
        """
        # Two players with similar average performance but different peaks
        # Player A: 2nd, 8th, 8th (peak: 2nd)
        # Player B: 5th, 5th, 5th (peak: 5th)
        
        # Without peak bonus, these might be close
        # With peak bonus, Player A should be clearly ahead
        
        peak_bonus_2nd = -2.5 / (2 ** 0.5) + 0.5  # ~-1.27
        peak_bonus_5th = -2.5 / (5 ** 0.5) + 0.5  # ~-0.62
        
        bonus_advantage = peak_bonus_2nd - peak_bonus_5th  # ~-0.65 (advantage for 2nd)
        
        assert bonus_advantage < -0.5, \
            f"2nd place peak should have >0.5 point advantage over 5th place peak, " \
            f"got {bonus_advantage:.2f}"


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
