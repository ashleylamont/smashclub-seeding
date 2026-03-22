from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import yaml

from seeding_algorithm import COMPANY_ALIASES, COMPANY_CODES, PlayerInput, clean_player_entry

PLAYERS_YAML_PATH = 'players.yaml'


@dataclass(frozen=True)
class RegistryPlayer:
    player_id: str
    canonical_name: str
    company: str
    aliases: List[str]
    past_companies: List[str] = None  # Companies they may have appeared under historically

    def __post_init__(self):
        if self.past_companies is None:
            object.__setattr__(self, 'past_companies', [])

    def resolve_company(self, observed_company: str) -> str:
        """Resolve an observed company to the canonical company, checking past_companies."""
        observed_normalized = observed_company.lower() if observed_company else 'n/a'
        
        # Check if it matches canonical company
        if observed_normalized == self.company.lower():
            return self.company
        
        # Check if it's in past_companies
        for past_company in self.past_companies:
            if observed_normalized == past_company.lower():
                return self.company
        
        # Return the canonical company as fallback
        return self.company

    @property
    def company_code(self) -> Optional[str]:
        for code, company_name in COMPANY_CODES.items():
            if company_name == self.company:
                return code
        return None


class PlayerRegistry:
    def __init__(self, path: str = PLAYERS_YAML_PATH):
        self.path = path
        self.players: List[RegistryPlayer] = []
        self.alias_map: Dict[Tuple[str, str], RegistryPlayer] = {}
        self.loaded = False
        self._load()

    def _normalize_company_to_name(self, company: Optional[str]) -> str:
        if not company:
            return 'N/A'
        if company in COMPANY_CODES:
            return COMPANY_CODES[company]
        upper = company.upper()
        if upper in COMPANY_CODES:
            return COMPANY_CODES[upper]
        for alias, code in COMPANY_ALIASES.items():
            if alias.lower() == company.lower():
                return COMPANY_CODES[code]
        return company

    def _normalize_alias_entry(self, value: str) -> Tuple[str, str]:
        name, company_code = clean_player_entry(value)
        company_name = self._normalize_company_to_name(company_code)
        return name.lower(), company_name.lower()

    def _load(self) -> None:
        if not os.path.exists(self.path):
            self.loaded = False
            return
        with open(self.path, 'r') as f:
            payload = yaml.safe_load(f) or {}
        players = payload.get('players', [])
        self.players = []
        self.alias_map = {}
        for item in players:
            past_companies_raw = item.get('past_companies', [])
            past_companies_normalized = [
                self._normalize_company_to_name(c) for c in past_companies_raw
            ]
            player = RegistryPlayer(
                player_id=item['id'],
                canonical_name=item['canonical_name'],
                company=self._normalize_company_to_name(item.get('company')),
                aliases=list(item.get('aliases', [])),
                past_companies=past_companies_normalized,
            )
            self.players.append(player)
            canonical_key = (player.canonical_name.lower(), player.company.lower())
            self.alias_map[canonical_key] = player
            # Add entries for past companies so resolve() can find them
            for past_company in player.past_companies:
                past_key = (player.canonical_name.lower(), past_company.lower())
                self.alias_map[past_key] = player
            for alias in player.aliases:
                self.alias_map[self._normalize_alias_entry(alias)] = player
        
        # Second pass: add N/A fallback for players with a company, if no explicit N/A player exists
        for player in self.players:
            if player.company.lower() != 'n/a':
                na_key = (player.canonical_name.lower(), 'n/a')
                if na_key not in self.alias_map:
                    self.alias_map[na_key] = player
        self.loaded = True

    def resolve(self, raw_name: str, company: Optional[str] = None) -> Optional[RegistryPlayer]:
        cleaned_name, cleaned_company_code = clean_player_entry(raw_name)
        company_name = self._normalize_company_to_name(cleaned_company_code or company)
        keys = [
            (cleaned_name.lower(), company_name.lower()),
            (cleaned_name.lower(), 'n/a'),
        ]
        for key in keys:
            player = self.alias_map.get(key)
            if player:
                return player
        return None

    def canonical_display(self, raw_name: str, company: Optional[str] = None) -> Optional[str]:
        player = self.resolve(raw_name, company)
        if not player:
            return None
        code = player.company_code
        return f'[{code}] {player.canonical_name}' if code else player.canonical_name

    def suggest_update_message(self, raw_name: str, company: Optional[str] = None) -> str:
        cleaned_name, cleaned_company_code = clean_player_entry(raw_name)
        company_name = self._normalize_company_to_name(cleaned_company_code or company)
        return (
            f"Unmatched against players.yaml: '{cleaned_name}' ({company_name}). "
            f"Consider adding a new player entry or an alias in {self.path}."
        )


_registry: Optional[PlayerRegistry] = None


def reset_player_registry() -> None:
    global _registry
    _registry = None


def _slugify_player_id(name: str) -> str:
    slug = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')
    return slug or 'player'


def write_registry_bootstrap(players: List[PlayerInput], output_path: str = 'players.bootstrap.yaml') -> str:
    seen = set()
    entries = []
    for player in players:
        company_name = PlayerRegistry()._normalize_company_to_name(player.company)
        key = (player.name.lower(), company_name.lower())
        if key in seen:
            continue
        seen.add(key)
        entries.append(
            {
                'id': _slugify_player_id(player.name),
                'canonical_name': player.name,
                'company': company_name,
                'aliases': [],
            }
        )
    with open(output_path, 'w') as f:
        yaml.safe_dump({'players': entries}, f, sort_keys=False)
    return output_path


def get_player_registry() -> PlayerRegistry:
    global _registry
    if _registry is None:
        _registry = PlayerRegistry()
    return _registry
