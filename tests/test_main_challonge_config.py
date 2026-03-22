"""Tests for Challonge tournament config file helpers in main.py."""

import os
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import main
from main import (
    DEFAULT_CHALLONGE_SOURCES_FILE,
    _get_default_challonge_sources_file,
    _load_challonge_sources_file,
    _resolve_challonge_sources,
)


def test_load_challonge_sources_file_ignores_comments_and_blank_lines(tmp_path):
    config_file = tmp_path / 'challonge_tournaments.txt'
    config_file.write_text(
        '# weekly set list\n\nweekly1\n  https://challonge.com/monthly_finals  \n# another comment\nweekly2\n'
    )

    sources = _load_challonge_sources_file(str(config_file))

    assert sources == ['weekly1', 'https://challonge.com/monthly_finals', 'weekly2']


def test_resolve_challonge_sources_combines_file_and_cli_values(tmp_path):
    config_file = tmp_path / 'challonge_tournaments.txt'
    config_file.write_text('weekly1\nweekly2\n')

    sources = _resolve_challonge_sources(['monthly_finals', 'https://challonge.com/special'], str(config_file))

    assert sources == ['weekly1', 'weekly2', 'monthly_finals', 'https://challonge.com/special']


def test_resolve_challonge_sources_returns_empty_list_without_inputs():
    assert _resolve_challonge_sources(None, None) == []


def test_load_challonge_sources_file_raises_for_missing_file(tmp_path):
    missing_file = tmp_path / 'does_not_exist.txt'

    with pytest.raises(FileNotFoundError):
        _load_challonge_sources_file(str(missing_file))


def test_get_default_challonge_sources_file_prefers_explicit_path(tmp_path):
    explicit_file = tmp_path / 'custom.txt'

    assert _get_default_challonge_sources_file(str(explicit_file)) == str(explicit_file)


def test_get_default_challonge_sources_file_uses_default_when_present(monkeypatch, tmp_path):
    default_file = tmp_path / DEFAULT_CHALLONGE_SOURCES_FILE
    default_file.write_text('weekly1\n')
    monkeypatch.chdir(tmp_path)

    assert _get_default_challonge_sources_file(None) == DEFAULT_CHALLONGE_SOURCES_FILE


def test_get_default_challonge_sources_file_returns_none_when_missing(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)

    assert _get_default_challonge_sources_file(None) is None
