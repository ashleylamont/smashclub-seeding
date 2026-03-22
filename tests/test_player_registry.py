import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from player_registry import PlayerRegistry, reset_player_registry


def test_player_registry_resolves_alias_and_canonical_name(tmp_path):
    registry_file = tmp_path / 'players.yaml'
    registry_file.write_text(
        'players:\n'
        '  - id: jackson-lin\n'
        '    canonical_name: Jackson Lin\n'
        '    company: Atlassian\n'
        '    aliases:\n'
        '      - Jackson\n'
        '      - Jackson L\n'
    )

    registry = PlayerRegistry(str(registry_file))

    player = registry.resolve('Jackson', 'ATL')
    assert player is not None
    assert player.canonical_name == 'Jackson Lin'
    assert player.company == 'Atlassian'


def test_player_registry_suggest_update_message_mentions_players_yaml(tmp_path):
    registry = PlayerRegistry(str(tmp_path / 'missing_players.yaml'))

    message = registry.suggest_update_message('Unmatched Person', 'ATL')

    assert 'players.yaml' in message or 'missing_players.yaml' in message
    assert 'Unmatched Person' in message
