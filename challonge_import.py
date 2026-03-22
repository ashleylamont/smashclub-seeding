from __future__ import annotations

import csv
import datetime as dt
import json
import os
import re
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Dict, List, Optional, Sequence, Tuple
from urllib.parse import urlparse

import requests
from dotenv import load_dotenv

from seeding_algorithm import COMPANY_CODES, clean_player_entry, find_similar_player
from player_registry import get_player_registry

CHALLONGE_API_BASE = "https://api.challonge.com/v1"
CHALLONGE_PUBLIC_BASE = "https://challonge.com"
CHALLONGE_REQUEST_HEADERS = {
    "Accept": "application/json",
    "User-Agent": "smashclub-seeding/0.1 (+local CLI import)",
}
CSV_HEADERS = ["Date", "Tournament", "Player 1", "Player 2", "Winner"]
ALIAS_REJECTED = "__KEEP_SEPARATE__"
CHALLONGE_CACHE_DIR = ".challonge-cache"
CHALLONGE_CACHE_VERSION = 4
CHALLONGE_ALIAS_FILE = ".challonge-aliases.json"
CHALLONGE_ALIAS_VERSION = 1


class ChallongeImportError(Exception):
    def __init__(self, message: str, status_code: Optional[int] = None):
        super().__init__(message)
        self.status_code = status_code


@dataclass(frozen=True)
class ChallongeCredentials:
    username: str
    api_key: str


@dataclass(frozen=True)
class CanonicalPlayer:
    name: str
    company_code: Optional[str]
    display_name: str


@dataclass
class NameNormalizationSummary:
    cleaned_names: int = 0
    exact_name_merges: int = 0
    fuzzy_merges: int = 0
    suspicious_names: int = 0


def _load_credentials() -> ChallongeCredentials:
    load_dotenv()
    username = os.getenv("CHALLONGE_USERNAME", "").strip()
    api_key = os.getenv("CHALLONGE_API_KEY", "").strip()
    if not username or not api_key:
        raise ChallongeImportError(
            "Missing Challonge credentials. Set CHALLONGE_USERNAME and CHALLONGE_API_KEY in your environment or .env file."
        )
    return ChallongeCredentials(username=username, api_key=api_key)


def _normalize_tournament_id(tournament_id: str) -> str:
    raw = tournament_id.strip()
    if not raw:
        raise ChallongeImportError("Tournament ID cannot be empty.")
    if "://" not in raw:
        return raw.strip("/")
    parsed = urlparse(raw)
    parts = [part for part in parsed.path.split("/") if part]
    if not parts:
        raise ChallongeImportError(f"Could not extract a tournament ID from '{tournament_id}'.")
    if parts[0] == "tournaments" and len(parts) > 1:
        return parts[1]
    return parts[0]


def _request_json(url: str, credentials: Optional[ChallongeCredentials] = None, use_auth: bool = True) -> object:
    kwargs = {"headers": CHALLONGE_REQUEST_HEADERS, "timeout": 30}
    if use_auth and credentials is not None:
        kwargs["auth"] = (credentials.username, credentials.api_key)
    try:
        response = requests.get(url, **kwargs)
    except requests.RequestException as exc:
        raise ChallongeImportError(f"Failed to reach Challonge API: {exc}") from exc
    if response.status_code == 401:
        raise ChallongeImportError(
            "Challonge API authentication failed (401 Unauthorized). Check CHALLONGE_USERNAME and CHALLONGE_API_KEY.",
            status_code=401,
        )
    if response.status_code == 404:
        raise ChallongeImportError("Challonge tournament not found (404). Check the tournament ID or URL.", status_code=404)
    if not response.ok:
        detail = response.text.strip()
        if len(detail) > 200:
            detail = detail[:197] + "..."
        raise ChallongeImportError(
            f"Challonge API request failed ({response.status_code}): {detail or 'No response body returned.'}",
            status_code=response.status_code,
        )
    try:
        return response.json()
    except ValueError as exc:
        raise ChallongeImportError("Challonge API returned invalid JSON.") from exc


def _request_api_json(endpoint: str, credentials: ChallongeCredentials) -> object:
    return _request_json(f"{CHALLONGE_API_BASE}/{endpoint}", credentials=credentials, use_auth=True)


def _request_public_bracket_json(tournament_slug: str) -> object:
    return _request_json(f"{CHALLONGE_PUBLIC_BASE}/{tournament_slug}.json", use_auth=False)


def _extract_tournament_payload(payload: object) -> Dict:
    if not isinstance(payload, dict) or not isinstance(payload.get("tournament"), dict):
        raise ChallongeImportError("Unexpected tournament response format from Challonge API.")
    return payload["tournament"]


def _extract_wrapped_list(payload: object, key: str, description: str) -> List[Dict]:
    if not isinstance(payload, list):
        raise ChallongeImportError(f"Unexpected {description} response format from Challonge API.")
    out = []
    for item in payload:
        if isinstance(item, dict) and isinstance(item.get(key), dict):
            out.append(item[key])
        else:
            raise ChallongeImportError(f"Unexpected {description} item format from Challonge API.")
    return out


def _parse_challonge_date(raw_date: Optional[str]) -> str:
    if not raw_date:
        return dt.date.today().isoformat()
    normalized = raw_date.replace("Z", "+00:00")
    try:
        parsed = dt.datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise ChallongeImportError(f"Could not parse Challonge date '{raw_date}'.") from exc
    return parsed.date().isoformat()


def _humanize_tournament_slug(slug: str) -> str:
    special = {
        "titlesponsorbattlegrounds": "Title Sponsor Battlegrounds",
        "titlesponsorrookierumble": "Title Sponsor Rookie Rumble",
        "framedatasignalschampionship": "Frame Data Signals Championship",
        "enterprisetransformationopen": "Enterprise Transformation Open",
        "fuelthefightwheel": "Fuel the Fight Wheel",
        "devoopsopen": "DevOops Open",
        "elevateyourgame": "Elevate Your Game",
        "teamkken24": "Team KKEN 24",
        "pavethepath": "Pave the Path",
        "devprodpunchout": "DevProd Punch Out",
    }
    lowered = slug.lower()
    if lowered.startswith("techinplace"):
        suffix = lowered[len("techinplace"):]
        parts = re.findall(r"[a-zA-Z]+|\d+", suffix)
        return " ".join(["Tech", "In", "Place"] + [part.capitalize() for part in parts]).strip()
    if lowered in special:
        return special[lowered]
    value = re.sub(r"([a-z])([A-Z])", r"\1 \2", slug)
    value = re.sub(r"([A-Za-z])(\d)", r"\1 \2", value)
    value = re.sub(r"(\d)([A-Za-z])", r"\1 \2", value)
    value = value.replace("_", " ").replace("-", " ")
    return " ".join(part.capitalize() for part in value.split()) or slug


def _build_row(tournament_name: str, tournament_date: str, player1: str, player2: str, winner: int) -> Dict[str, object]:
    return {"Date": tournament_date, "Tournament": tournament_name, "Player 1": player1, "Player 2": player2, "Winner": winner}


def _warn_if_likely_2v2(tournament_name: str, participant_names: Sequence[str]) -> None:
    names = [name.strip() for name in participant_names if name and name.strip()]
    if len(names) < 8:
        return

    pipe_like = sum(1 for name in names if "|" in name or " / " in name or " & " in name)
    long_names = sum(1 for name in names if len(name.split()) >= 4)
    suspicious_ratio = max(pipe_like / len(names), long_names / len(names))

    if pipe_like >= max(3, len(names) // 4) or long_names >= max(4, len(names) // 3) or suspicious_ratio >= 0.4:
        print(
            f"Warning: {tournament_name} may be a 2v2/team-format tournament "
            f"({pipe_like}/{len(names)} names contain team separators, {long_names}/{len(names)} have 4+ words)."
        )


def _cache_file_path(tournament_id: str) -> str:
    safe_id = re.sub(r"[^a-zA-Z0-9._-]", "_", tournament_id)
    return os.path.join(CHALLONGE_CACHE_DIR, f"{safe_id}.json")


def _load_persisted_alias_decisions() -> Dict[str, str]:
    if not os.path.exists(CHALLONGE_ALIAS_FILE):
        return {}
    try:
        with open(CHALLONGE_ALIAS_FILE, 'r') as f:
            payload = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}
    if payload.get('version') != CHALLONGE_ALIAS_VERSION:
        return {}
    decisions = payload.get('decisions', {})
    return decisions if isinstance(decisions, dict) else {}


def _write_persisted_alias_decisions(decisions: Dict[str, str]) -> None:
    payload = {
        'version': CHALLONGE_ALIAS_VERSION,
        'updated_at': dt.datetime.now(dt.timezone.utc).isoformat(),
        'decisions': decisions,
    }
    with open(CHALLONGE_ALIAS_FILE, 'w') as f:
        json.dump(payload, f, indent=2, sort_keys=True)


def _load_cached_tournament_rows(tournament_id: str, verbose: bool = False) -> Optional[List[Dict[str, object]]]:
    cache_path = _cache_file_path(tournament_id)
    if not os.path.exists(cache_path):
        return None
    try:
        with open(cache_path, 'r') as f:
            payload = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None

    if payload.get('cache_version') != CHALLONGE_CACHE_VERSION:
        return None
    rows = payload.get('rows')
    if not isinstance(rows, list):
        return None
    if verbose:
        print(f"[Challonge] {tournament_id}: using local cache {cache_path}")
    _warn_unmatched_registry_rows(rows)
    return rows


def _write_cached_tournament_rows(
    tournament_id: str,
    rows: List[Dict[str, object]],
    source: str,
    completed_at: Optional[str],
    verbose: bool = False,
) -> None:
    os.makedirs(CHALLONGE_CACHE_DIR, exist_ok=True)
    cache_path = _cache_file_path(tournament_id)
    payload = {
        "cache_version": CHALLONGE_CACHE_VERSION,
        "tournament_id": tournament_id,
        "source": source,
        "completed_at": completed_at,
        "cached_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "rows": rows,
    }
    with open(cache_path, "w") as f:
        json.dump(payload, f, indent=2, sort_keys=True)
    if verbose:
        print(f"[Challonge] {tournament_id}: cached completed tournament to {cache_path}")


def _extract_rows_from_api_payloads(tournament_id: str, tournament: Dict, participants: List[Dict], matches: List[Dict], verbose: bool) -> Tuple[List[Dict[str, object]], bool, Optional[str]]:
    participant_names = {
        participant["id"]: (participant.get("display_name") or participant.get("name") or "").strip()
        for participant in participants
        if participant.get("id") is not None and (participant.get("display_name") or participant.get("name"))
    }
    tournament_name = (tournament.get("name") or tournament.get("full_challonge_url") or tournament_id).strip()
    tournament_date = _parse_challonge_date(tournament.get("completed_at") or tournament.get("updated_at"))
    _warn_if_likely_2v2(tournament_name, list(participant_names.values()))
    rows: List[Dict[str, object]] = []
    skipped_incomplete = skipped_missing_players = skipped_missing_names = 0
    for match in matches:
        if match.get("state") != "complete":
            skipped_incomplete += 1
            continue
        player1_id = match.get("player1_id")
        player2_id = match.get("player2_id")
        winner_id = match.get("winner_id")
        if player1_id is None or player2_id is None or winner_id not in {player1_id, player2_id}:
            skipped_missing_players += 1
            continue
        player1_name = participant_names.get(player1_id)
        player2_name = participant_names.get(player2_id)
        if not player1_name or not player2_name:
            skipped_missing_names += 1
            continue
        rows.append(_build_row(tournament_name, tournament_date, player1_name, player2_name, 1 if winner_id == player1_id else 2))
    completed = bool(tournament.get("completed_at")) or str(tournament.get("state", "")).lower() == "complete"
    completed_at = tournament.get("completed_at") or tournament.get("updated_at")
    if verbose:
        print(f"[Challonge] {tournament_id}: official API imported {len(rows)} completed matches (skipped incomplete={skipped_incomplete}, missing_players={skipped_missing_players}, missing_names={skipped_missing_names})")
    return rows, completed, completed_at


def _extract_rows_from_public_payload(tournament_id: str, payload: object, verbose: bool) -> Tuple[List[Dict[str, object]], bool, Optional[str]]:
    if not isinstance(payload, dict) or not isinstance(payload.get("matches_by_round"), dict):
        raise ChallongeImportError("Public Challonge bracket JSON did not include matches_by_round data.")
    all_matches: List[Dict] = []
    for round_matches in payload["matches_by_round"].values():
        if isinstance(round_matches, list):
            all_matches.extend(match for match in round_matches if isinstance(match, dict))
    completed_matches = [match for match in all_matches if match.get("state") == "complete"]
    match_dates = [match.get("underway_at") for match in completed_matches if match.get("underway_at")]
    tournament_date = _parse_challonge_date(max(match_dates) if match_dates else None)
    tournament_name = _humanize_tournament_slug(tournament_id)
    public_names = []
    for match in completed_matches:
        player1 = match.get("player1") or {}
        player2 = match.get("player2") or {}
        public_names.extend([
            (player1.get("display_name") or player1.get("name") or "").strip(),
            (player2.get("display_name") or player2.get("name") or "").strip(),
        ])
    _warn_if_likely_2v2(tournament_name, public_names)
    rows: List[Dict[str, object]] = []
    skipped_missing_players = 0
    for match in completed_matches:
        player1 = match.get("player1") or {}
        player2 = match.get("player2") or {}
        player1_id = player1.get("id")
        player2_id = player2.get("id")
        winner_id = match.get("winner_id")
        player1_name = (player1.get("display_name") or player1.get("name") or "").strip()
        player2_name = (player2.get("display_name") or player2.get("name") or "").strip()
        if not player1_id or not player2_id or not player1_name or not player2_name or winner_id not in {player1_id, player2_id}:
            skipped_missing_players += 1
            continue
        rows.append(_build_row(tournament_name, tournament_date, player1_name, player2_name, 1 if winner_id == player1_id else 2))
    all_complete = bool(all_matches) and all(match.get("state") == "complete" for match in all_matches)
    completed_at = max(match_dates) if match_dates else None
    if verbose:
        print(f"[Challonge] {tournament_id}: public slug fallback imported {len(rows)} completed matches (skipped missing_players={skipped_missing_players})")
    return rows, all_complete, completed_at


def _prepare_player_entry(raw_name: str) -> str:
    stripped = raw_name.strip()
    from seeding_algorithm import COMPANY_ALIASES

    def resolve_company(company_candidate: str) -> Optional[str]:
        for alias in COMPANY_CODES.keys():
            if company_candidate.upper() == alias:
                return alias
        for alias, code in COMPANY_ALIASES.items():
            if company_candidate.lower() == alias.lower():
                return code
        return None

    pipe_match = re.match(r"^([^|]+)\|\s*(.+)$", stripped)
    if pipe_match:
        code = resolve_company(pipe_match.group(1).strip())
        if code:
            return f"[{code}] {pipe_match.group(2).strip()}"

    leading_paren_match = re.match(r"^\(([^)]+)\)\s*(.+)$", stripped)
    if leading_paren_match:
        code = resolve_company(leading_paren_match.group(1).strip())
        if code:
            return f"[{code}] {leading_paren_match.group(2).strip()}"

    trailing_paren_match = re.match(r"^(.+?)\s*\(([^)]+)\)$", stripped)
    if trailing_paren_match:
        code = resolve_company(trailing_paren_match.group(2).strip())
        if code:
            return f"[{code}] {trailing_paren_match.group(1).strip()}"

    return stripped


def _format_canonical_player_display(name: str, company_code: Optional[str]) -> str:
    return f"[{company_code}] {name}" if company_code else name


def _registry_resolve_display(raw_name: str, company_code: Optional[str], verbose: bool = False) -> Optional[str]:
    registry = get_player_registry()
    player = registry.resolve(raw_name, company_code)
    if not player:
        return None
    display = _format_canonical_player_display(player.canonical_name, player.company_code)
    if verbose:
        print(f"[players.yaml] matched '{raw_name}' -> '{display}'")
    return display


def _build_similarity_calculator(canonical_entries: Dict[Tuple[str, str], CanonicalPlayer]) -> SimpleNamespace:
    results = []
    for entry in canonical_entries.values():
        company_name = COMPANY_CODES.get(entry.company_code, "N/A") if entry.company_code else "N/A"
        results.append(SimpleNamespace(player_name=entry.name, company=company_name))
    return SimpleNamespace(results=results)


def _resolve_similar_entry(name: str, company_code: Optional[str], canonical_entries: Dict[Tuple[str, str], CanonicalPlayer]) -> Tuple[Optional[CanonicalPlayer], float]:
    if not canonical_entries:
        return None, 0.0
    calc = _build_similarity_calculator(canonical_entries)
    similar = find_similar_player(name, company_code, calc)
    if not similar:
        return None, 0.0
    matched_name, score = similar
    candidates = [entry for entry in canonical_entries.values() if entry.name == matched_name]
    if company_code is not None:
        same_company = [entry for entry in candidates if entry.company_code == company_code]
        if len(same_company) == 1:
            return same_company[0], score
        no_company = [entry for entry in candidates if entry.company_code is None]
        if len(no_company) == 1 and not same_company:
            return no_company[0], score
        candidates = same_company or no_company or candidates
    if len(candidates) != 1:
        return None, 0.0
    return candidates[0], score


def _first_name_compatible(a: str, b: str) -> bool:
    a = a.lower()
    b = b.lower()
    return a == b or (len(a) >= 4 and b.startswith(a)) or (len(b) >= 4 and a.startswith(b))


def _resolve_structured_alias(name: str, company_code: Optional[str], canonical_entries: Dict[Tuple[str, str], CanonicalPlayer]) -> Optional[CanonicalPlayer]:
    parts = name.split()
    entries = [entry for entry in canonical_entries.values() if company_code is None or entry.company_code == company_code]
    if not entries:
        return None

    if len(parts) == 1:
        matches = [entry for entry in entries if len(entry.name.split()) >= 2 and parts[0].lower() == entry.name.split()[0].lower()]
        unique = {(entry.name, entry.company_code): entry for entry in matches}
        return next(iter(unique.values())) if len(unique) == 1 else None

    if len(parts) == 2 and len(parts[1]) == 1:
        first, initial = parts[0], parts[1].lower()
        matches = []
        for entry in entries:
            entry_parts = entry.name.split()
            if len(entry_parts) < 2:
                continue
            if _first_name_compatible(first, entry_parts[0]) and entry_parts[-1].lower().startswith(initial):
                matches.append(entry)
        unique = {(entry.name, entry.company_code): entry for entry in matches}
        return next(iter(unique.values())) if len(unique) == 1 else None

    return None


def _alias_pair_key(imported_display: str, existing_display: str) -> Tuple[str, str]:
    return (imported_display.strip().lower(), existing_display.strip().lower())


def _persisted_alias_keys(imported_display: str, existing_display: str, exact_key: Tuple[str, str]) -> List[str]:
    return [
        f"pair::{imported_display.strip().lower()}::{existing_display.strip().lower()}",
        f"exact::{exact_key[0]}::{exact_key[1]}",
    ]


def _display_specificity(display_name: str) -> Tuple[int, int, int]:
    has_company = 1 if display_name.startswith('[') else 0
    cleaned = re.sub(r"^\[[^]]+\]\s*", "", display_name).strip()
    parts = cleaned.split()
    token_score = len(parts)
    length_score = len(cleaned)
    return (has_company, token_score, length_score)


def _prefer_more_specific_display(a: str, b: str) -> str:
    return a if _display_specificity(a) >= _display_specificity(b) else b


def _prompt_merge_choice(imported_display: str, existing_display: str) -> Optional[str]:
    print(f"\n⚠ Possible Challonge player alias detected:")
    print(f"   Imported: {imported_display}")
    print(f"   Existing: {existing_display}")
    print("   Enter one of:")
    print("   - y / yes : merge and keep the existing name")
    print("   - n / no  : keep them separate")
    print("   - a preferred merged name (optionally with company tag)")
    response = input("   Choice: ").strip()
    if not response:
        return None
    lowered = response.lower()
    if lowered in {"y", "yes"}:
        return existing_display
    if lowered in {"n", "no"}:
        return None
    return response


def _canonicalize_player_name(raw_name: str, canonical_entries: Dict[Tuple[str, str], CanonicalPlayer], renamed_displays: Dict[str, str], alias_decisions: Dict[Tuple[str, str], str], persisted_aliases: Dict[str, str], unmatched_registry_entries: set[str], interactive: bool, verbose: bool, summary: NameNormalizationSummary) -> str:
    prepared_name = _prepare_player_entry(raw_name)
    cleaned_name, company_code = clean_player_entry(prepared_name)
    company_key = company_code or ""
    exact_key = (cleaned_name.lower(), company_key)
    cleaned_display = _format_canonical_player_display(cleaned_name, company_code)
    registry_display = _registry_resolve_display(prepared_name, company_code, verbose=verbose)
    if registry_display:
        canonical_entries[(registry_display.lower(), company_key)] = CanonicalPlayer(
            registry_display.replace(f'[{company_code}] ', '') if company_code and registry_display.startswith(f'[{company_code}] ') else registry_display,
            company_code,
            registry_display,
        )
        return registry_display
    if raw_name.strip() != cleaned_display:
        summary.cleaned_names += 1
        if verbose:
            print(f"[Challonge] normalize: '{raw_name}' -> '{cleaned_display}'")
    if exact_key in canonical_entries:
        return canonical_entries[exact_key].display_name
    if exact_key in alias_decisions:
        cached_display = alias_decisions[exact_key]
        if cached_display != ALIAS_REJECTED:
            return cached_display

    persisted_exact = persisted_aliases.get(f"exact::{exact_key[0]}::{exact_key[1]}")
    if persisted_exact and persisted_exact != ALIAS_REJECTED:
        preferred = _prefer_more_specific_display(cleaned_display, persisted_exact)
        if preferred != persisted_exact and verbose:
            print(f"[Challonge] ignored weaker persisted alias '{persisted_exact}' in favor of '{preferred}'")
        return preferred

    same_name_entries = [entry for entry in canonical_entries.values() if entry.name.lower() == cleaned_name.lower()]
    if same_name_entries and len(same_name_entries) == 1:
        summary.exact_name_merges += 1
        if verbose:
            print(f"[Challonge] merged exact name variant '{cleaned_display}' -> '{same_name_entries[0].display_name}'")
        return same_name_entries[0].display_name

    structured_entry = _resolve_structured_alias(cleaned_name, company_code, canonical_entries)
    if structured_entry:
        summary.exact_name_merges += 1
        alias_decisions[exact_key] = structured_entry.display_name
        if verbose:
            print(f"[Challonge] resolved structured alias '{cleaned_display}' -> '{structured_entry.display_name}'")
        return structured_entry.display_name

    similar_entry, score = _resolve_similar_entry(cleaned_name, company_code, canonical_entries)
    company_signal_strong = company_code is not None and similar_entry is not None and similar_entry.company_code is not None
    allow_fuzzy = (
        similar_entry is not None
        and score >= 0.85
        and (
            company_signal_strong
            or (len(cleaned_name.split()) >= 2 and len(similar_entry.name.split()) >= 2)
        )
    )
    if allow_fuzzy and similar_entry:
        pair_key = _alias_pair_key(cleaned_display, similar_entry.display_name)
        if pair_key in alias_decisions:
            cached_decision = alias_decisions[pair_key]
            if cached_decision == ALIAS_REJECTED:
                if verbose:
                    print(f"[Challonge] reusing prior keep-separate decision for '{cleaned_display}' vs '{similar_entry.display_name}'")
            else:
                chosen_display = _prefer_more_specific_display(cached_decision, _prefer_more_specific_display(cleaned_display, similar_entry.display_name))
                if verbose:
                    print(f"[Challonge] reusing prior alias merge '{cleaned_display}' -> '{chosen_display}'")
                alias_decisions[exact_key] = chosen_display
                return chosen_display
        else:
            auto_merge = score >= 0.96 or (not interactive and score >= 0.9 and company_signal_strong and company_code == similar_entry.company_code)
            if auto_merge:
                summary.fuzzy_merges += 1
                chosen_display = _prefer_more_specific_display(cleaned_display, similar_entry.display_name)
                alias_decisions[pair_key] = chosen_display
                alias_decisions[exact_key] = chosen_display
                for persisted_key in _persisted_alias_keys(cleaned_display, similar_entry.display_name, exact_key):
                    persisted_aliases[persisted_key] = chosen_display
                if verbose:
                    print(f"[Challonge] auto-merged similar player '{cleaned_display}' -> '{chosen_display}' (score={score:.2f})")
                return chosen_display
            if interactive:
                print(f"   Similarity: {score:.2f}")
                merge_choice = _prompt_merge_choice(cleaned_display, similar_entry.display_name)
                if merge_choice == similar_entry.display_name:
                    summary.fuzzy_merges += 1
                    chosen_display = _prefer_more_specific_display(cleaned_display, similar_entry.display_name)
                    alias_decisions[pair_key] = chosen_display
                    alias_decisions[exact_key] = chosen_display
                    for persisted_key in _persisted_alias_keys(cleaned_display, similar_entry.display_name, exact_key):
                        persisted_aliases[persisted_key] = chosen_display
                    if verbose:
                        print(f"[Challonge] confirmed alias merge '{cleaned_display}' -> '{chosen_display}'")
                    return chosen_display
                if merge_choice and merge_choice != similar_entry.display_name:
                    preferred_prepared = _prepare_player_entry(merge_choice)
                    preferred_name, preferred_company_code = clean_player_entry(preferred_prepared)
                    preferred_company_code = preferred_company_code or company_code or similar_entry.company_code
                    preferred_display = _format_canonical_player_display(preferred_name, preferred_company_code)
                    preferred_entry = CanonicalPlayer(preferred_name, preferred_company_code, preferred_display)
                    canonical_entries[(preferred_name.lower(), preferred_company_code or "")] = preferred_entry
                    canonical_entries[(similar_entry.name.lower(), similar_entry.company_code or "")] = preferred_entry
                    canonical_entries[exact_key] = preferred_entry
                    renamed_displays[similar_entry.display_name] = preferred_display
                    alias_decisions[pair_key] = preferred_display
                    alias_decisions[exact_key] = preferred_display
                    for persisted_key in _persisted_alias_keys(cleaned_display, similar_entry.display_name, exact_key):
                        persisted_aliases[persisted_key] = preferred_display
                    summary.fuzzy_merges += 1
                    if verbose:
                        print(f"[Challonge] merged alias using preferred name '{preferred_display}'")
                    return preferred_display
                alias_decisions[pair_key] = ALIAS_REJECTED
                alias_decisions[exact_key] = ALIAS_REJECTED
                for persisted_key in _persisted_alias_keys(cleaned_display, similar_entry.display_name, exact_key):
                    persisted_aliases[persisted_key] = ALIAS_REJECTED
            elif verbose and company_signal_strong:
                summary.suspicious_names += 1
                print(f"Warning: Similar imported player names detected but kept separate: '{cleaned_display}' vs '{similar_entry.display_name}' (score={score:.2f})")

    canonical_entries[exact_key] = CanonicalPlayer(cleaned_name, company_code, cleaned_display)
    unmatched_registry_entries.add(get_player_registry().suggest_update_message(prepared_name, company_code))
    return cleaned_display


def _warn_unmatched_registry_rows(rows: List[Dict[str, object]]) -> None:
    registry = get_player_registry()
    messages: set[str] = set()
    for row in rows:
        for player_key in ['Player 1', 'Player 2']:
            raw_name = str(row[player_key])
            if not registry.resolve(raw_name):
                messages.add(registry.suggest_update_message(raw_name))
    for message in sorted(messages):
        print(f"Warning: {message}")


def _canonicalize_rows(rows: List[Dict[str, object]], interactive: bool, verbose: bool) -> List[Dict[str, object]]:
    canonical_entries: Dict[Tuple[str, str], CanonicalPlayer] = {}
    renamed_displays: Dict[str, str] = {}
    alias_decisions: Dict[Tuple[str, str], str] = {}
    persisted_aliases = _load_persisted_alias_decisions()
    original_persisted_aliases = dict(persisted_aliases)
    summary = NameNormalizationSummary()
    unmatched_registry_entries: set[str] = set()
    normalized_rows: List[Dict[str, object]] = []
    for row in rows:
        player1 = _canonicalize_player_name(str(row["Player 1"]), canonical_entries, renamed_displays, alias_decisions, persisted_aliases, unmatched_registry_entries, interactive, verbose, summary)
        player2 = _canonicalize_player_name(str(row["Player 2"]), canonical_entries, renamed_displays, alias_decisions, persisted_aliases, unmatched_registry_entries, interactive, verbose, summary)
        normalized_rows.append({**row, "Player 1": player1, "Player 2": player2})
    if renamed_displays:
        for row in normalized_rows:
            row["Player 1"] = renamed_displays.get(str(row["Player 1"]), str(row["Player 1"]))
            row["Player 2"] = renamed_displays.get(str(row["Player 2"]), str(row["Player 2"]))
    if persisted_aliases != original_persisted_aliases:
        _write_persisted_alias_decisions(persisted_aliases)
    for message in sorted(unmatched_registry_entries):
        print(f"Warning: {message}")
    if verbose:
        print(f"[Challonge] normalization summary: cleaned={summary.cleaned_names}, exact_merges={summary.exact_name_merges}, fuzzy_merges={summary.fuzzy_merges}, suspicious={summary.suspicious_names}, canonical_players={len(canonical_entries)}")
    return normalized_rows


def _fetch_tournament_rows(tournament_id: str, credentials: ChallongeCredentials, interactive: bool = False, verbose: bool = False) -> List[Dict[str, object]]:
    normalized_id = _normalize_tournament_id(tournament_id)
    cached_rows = _load_cached_tournament_rows(normalized_id, verbose=verbose)
    if cached_rows is not None:
        return cached_rows

    try:
        tournament_payload = _request_api_json(f"tournaments/{normalized_id}.json", credentials)
        participants_payload = _request_api_json(f"tournaments/{normalized_id}/participants.json", credentials)
        matches_payload = _request_api_json(f"tournaments/{normalized_id}/matches.json", credentials)
        tournament = _extract_tournament_payload(tournament_payload)
        participants = _extract_wrapped_list(participants_payload, "participant", "participants")
        matches = _extract_wrapped_list(matches_payload, "match", "matches")
        rows, is_complete, completed_at = _extract_rows_from_api_payloads(normalized_id, tournament, participants, matches, verbose)
        if is_complete:
            _write_cached_tournament_rows(normalized_id, rows, source="api", completed_at=completed_at, verbose=verbose)
        return rows
    except ChallongeImportError as exc:
        if exc.status_code != 404:
            raise ChallongeImportError(f"{normalized_id}: {exc}", status_code=exc.status_code) from exc
        if verbose:
            print(f"[Challonge] {normalized_id}: official API returned 404, trying public slug fallback")
        try:
            public_payload = _request_public_bracket_json(normalized_id)
            rows, is_complete, completed_at = _extract_rows_from_public_payload(normalized_id, public_payload, verbose)
            if is_complete:
                _write_cached_tournament_rows(normalized_id, rows, source="public", completed_at=completed_at, verbose=verbose)
            return rows
        except ChallongeImportError as public_exc:
            raise ChallongeImportError(f"{normalized_id}: {public_exc}", status_code=public_exc.status_code) from public_exc


def _write_rows_to_csv(rows: List[Dict[str, object]], output_csv: str) -> None:
    output_dir = os.path.dirname(os.path.abspath(output_csv))
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)
    with open(output_csv, "w", newline="") as csvfile:
        writer = csv.DictWriter(csvfile, fieldnames=CSV_HEADERS)
        writer.writeheader()
        writer.writerows(rows)


def fetch_tournament_matches(tournament_id: str, output_csv: str, interactive: bool = False, verbose: bool = False) -> int:
    credentials = _load_credentials()
    rows = _fetch_tournament_rows(tournament_id, credentials, interactive=interactive, verbose=verbose)
    normalized_rows = _canonicalize_rows(rows, interactive=interactive, verbose=verbose)
    _write_rows_to_csv(normalized_rows, output_csv)
    return len(normalized_rows)


def fetch_tournaments_matches(tournament_ids: Sequence[str], output_csv: str, interactive: bool = False, verbose: bool = False) -> int:
    normalized_inputs = [tournament_id.strip() for tournament_id in tournament_ids if tournament_id and tournament_id.strip()]
    if not normalized_inputs:
        raise ChallongeImportError("At least one Challonge tournament ID or URL is required.")
    credentials = _load_credentials()
    all_rows: List[Dict[str, object]] = []
    failures: List[str] = []
    for tournament_id in normalized_inputs:
        try:
            all_rows.extend(_fetch_tournament_rows(tournament_id, credentials, interactive=interactive, verbose=verbose))
        except ChallongeImportError as exc:
            failures.append(str(exc))
    if failures and not all_rows:
        raise ChallongeImportError("All Challonge tournament imports failed: " + " | ".join(failures))
    normalized_rows = _canonicalize_rows(all_rows, interactive=interactive, verbose=verbose)
    _write_rows_to_csv(normalized_rows, output_csv)
    if failures:
        print("Warning: Some Challonge tournaments could not be imported:")
        for failure in failures:
            print(f"  - {failure}")
    return len(normalized_rows)
