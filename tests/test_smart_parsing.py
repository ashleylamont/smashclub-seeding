"""
Tests for smart parsing functionality with fuzzy matching.
"""

import sys
import os

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import pytest
from seeding_algorithm import (
    SeedingCalculator,
    clean_player_entry,
    find_similar_player,
)


@pytest.fixture
def calculator():
    """Create a seeding calculator with test data."""
    return SeedingCalculator('tests/test_data.csv')


class TestCleanPlayerEntry:
    """Tests for cleaning messy player entries."""

    def test_clean_numbered_entry(self):
        """Should remove leading numbers."""
        name, company = clean_player_entry("1 [Atlas]@Lucina")
        assert name == "Lucina"
        assert company == "ATL"

    def test_clean_atlas_entry(self):
        """Should normalize Atlas to ATL."""
        name, company = clean_player_entry("[Atlas]@Robin")
        assert name == "Robin"
        assert company == "ATL"

    def test_clean_parenthetical_info(self):
        """Should remove parenthetical information."""
        name, company = clean_player_entry("Jack Morrison (Susquehanna, Smashclub alum) (Host @Robin)")
        assert name == "Jack Morrison"
        # @ in parentheses doesn't count (it's their host, not them)
        assert company is None

    def test_clean_google_duplicate(self):
        """Should remove duplicate company name at end."""
        name, company = clean_player_entry("[Google] Mako RutledgeGoogle")
        assert name == "Mako Rutledge"
        assert company == "GOOG"

    def test_clean_google_with_space(self):
        """Should remove duplicate company name with space."""
        name, company = clean_player_entry("[Google] Reinhardt Wilhelm Google")
        assert name == "Reinhardt Wilhelm"
        assert company == "GOOG"

    def test_clean_relevance_ai(self):
        """Should handle Relevance AI company."""
        name, company = clean_player_entry("[Relevance AI] Satya Vaswani")
        assert name == "Satya Vaswani"
        assert company == "REL"

    def test_clean_at_symbol(self):
        """Should remove @ symbols."""
        name, company = clean_player_entry("[Atlas]@Shulk")
        assert name == "Shulk"
        assert company == "ATL"

    def test_clean_whitespace(self):
        """Should normalize whitespace."""
        name, company = clean_player_entry("  [ATL]   Bob    Smith  ")
        assert name == "Fox McCloud"
        assert company == "ATL"

    def test_clean_switch_suffix(self):
        """Should remove 'Switch' at the end."""
        name, company = clean_player_entry("[Atlas] @Pit Switch")
        assert name == "Pit"
        assert company == "ATL"

    def test_clean_dash_comments(self):
        """Should remove everything after ' - ' (comments/descriptions)."""
        name, company = clean_player_entry("[Atlas]@Lucina - Ready to taunt and spike Donkeykong")
        assert name == "Lucina"
        assert company == "ATL"

    def test_clean_relevance_duplicate(self):
        """Should remove duplicate 'Relevance' for Relevance AI company."""
        name, company = clean_player_entry("[Relevance AI] Jack Morrison Relevance")
        assert name == "Jack Morrison"
        assert company == "REL"

    def test_clean_dietary_info(self):
        """Should remove dietary information in parentheses."""
        name, company = clean_player_entry("[Atlas]@Solid Snake (Dietary: Gluten Free)")
        assert name == "Solid Snake"
        assert company == "ATL"


class TestFuzzyMatching:
    """Tests for fuzzy matching against historical data."""

    def test_exact_match(self, calculator):
        """Should find exact matches with high confidence."""
        result = find_similar_player("Samus Aran", "ATL", calculator)
        assert result is not None
        matched_name, score = result
        assert matched_name == "Samus Aran"
        assert score >= 0.9

    def test_case_insensitive(self, calculator):
        """Should match regardless of case."""
        result = find_similar_player("samus aran", "ATL", calculator)
        assert result is not None
        matched_name, score = result
        assert matched_name == "Samus Aran"
        assert score >= 0.9

    def test_minor_typo(self, calculator):
        """Should suggest matches with minor typos."""
        result = find_similar_player("Samuss Aran", "ATL", calculator)
        assert result is not None
        matched_name, score = result
        assert matched_name == "Samus Aran"
        assert score >= 0.75  # Should still be high confidence

    def test_company_filter(self, calculator):
        """Should only match within same company."""
        # Fox McCloud is in Atlassian
        result = find_similar_player("Fox McCloud", "ATL", calculator)
        assert result is not None
        matched_name, score = result
        assert matched_name == "Fox McCloud"

        # Should not match Fox McCloud if looking in different company
        result = find_similar_player("Fox McCloud", "CAN", calculator)
        # Either no match or low confidence
        if result:
            _, score = result
            assert score < 0.9  # Should not be high confidence

    def test_first_last_name_matching(self, calculator):
        """Should match on first and last name separately."""
        # Even if middle part is wrong, should match on first+last
        result = find_similar_player("Samus X Aran", "ATL", calculator)
        assert result is not None
        matched_name, score = result
        assert matched_name == "Samus Aran"
        assert score >= 0.6

    def test_no_match_for_new_player(self, calculator):
        """Should return None for completely new players."""
        result = find_similar_player("Zaphod Beeblebrox", "ATL", calculator)
        # Either no match or very low confidence
        if result:
            _, score = result
            assert score < 0.6


class TestSmartParsingIntegration:
    """Integration tests for smart parsing (non-interactive)."""

    def test_messy_input_parsing(self, calculator):
        """Should handle messy real-world input."""
        from seeding_algorithm import smart_parse_player_list

        messy_input = """
1 [Atlas]@Lucina
[Google] Mako RutledgeGoogle
@Jack Morrison
"""

        # Non-interactive mode for testing
        players = smart_parse_player_list(messy_input, calculator, interactive=False)

        assert len(players) == 3
        assert players[0].name == "Lucina"
        assert players[0].company == "ATL"
        assert players[1].name == "Mako Rutledge"
        assert players[1].company == "GOOG"
        assert players[2].name == "Jack Morrison"
        assert players[2].company == "ATL"  # Inferred from @ symbol


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
