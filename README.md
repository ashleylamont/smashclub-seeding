# SSBU Tournament Seeding Tool 🎮

Automatically seed Super Smash Bros Ultimate tournaments based on historical player performance.

This tool was created to assist with event planning for Atlassian's [Smash Club](https://hello.atlassian.net/wiki/spaces/smash/overview).

It was also largely vibe-coded with Rovo Dev CLI, so there may be some quirks.

## Features

- **Weighted Scoring**: Recent tournaments weighted higher (exponential decay 0.8)
- **Smart Parsing**: Handles messy copy-paste formats from sign-up sheets
- **Fuzzy Matching**: Catches typos and suggests corrections
- **1v1 Priority**: Uses 1v1 results primarily, 2v2 for tiebreaking
- **Rookies Support**: Properly adjusts "1v1 Rookies" placements

## Quick Start

```bash
# Install dependencies
uv pip install pytest

# Run seeding
uv run python main.py --csv your_data.csv --players player_list.txt --details --bracket

# Run tests
uv run pytest tests/ -v
```

## Usage

## Usage

### Basic Usage
```bash
# Default (smart parsing + interactive prompts)
python main.py --csv data.csv --players list.txt

# With details and bracket
python main.py --csv data.csv --players list.txt --details --bracket

# Non-interactive (for scripts)
python main.py --csv data.csv --players list.txt --non-interactive
```

### Input Format Examples

**Messy formats (all work automatically):**
```
1 [Atlas]@Pit Switch
[Google] Mako RutledgeGoogle  
Lucina - Ready to taunt and spike
Kirby (Host: @King Dedede)
[Atlas]@Solid Snake (Dietary: Gluten Free)
```

**Clean formats:**
```
Samus Aran [ATL]
[CAN] Fox McCloud
Falco Lombardi
```

**Supported Companies:** ATL/Atlassian, CAN/Canva, OPT/Optiver, GOOG/Google, WOW/Woolworths, REL/Relevance AI, SUS/Susquehanna

**Company Inference:** 
- `@` symbol before name → Inferred as Atlassian (e.g., `@Samus Aran`)
- No `@` or brackets → No company (matches against all companies in history)

## Algorithm

### Scoring
- Uses **weighted average** of all 1v1 results with exponential decay (0.8)
- Recent tournaments weighted higher: 1.0, 0.8, 0.64, 0.51...
- Formula: `score = sum(placement × 0.8^index) / sum(0.8^index)`
- 2v2 results used for tiebreaking only

### CSV Format
```csv
Date,Company,Player name,Placement,Format,Tournament
2024-01-15,Atlassian,Samus Aran,1,1v1,Winter Bash 2024
2024-01-15,Atlassian,Fox McCloud,2,1v1,Winter Bash 2024
```

**Columns:** Date (YYYY-MM-DD), Company, Player name, Placement (integer), Format (1v1/2v2/1v1 Rookies), Tournament

You can export this data from the [Results Database](https://hello.atlassian.net/wiki/spaces/smash/database/5194207434).

## Testing

```bash
# Run all tests (51 tests)
uv run pytest tests/ -v

# Quick test
uv run pytest tests/ -q
```

## Command-Line Options

- `--csv FILE` - Historical results CSV (required)
- `--players FILE` - Player list file
- `--interactive` - Enter players interactively
- `--details` - Show detailed scoring
- `--bracket` - Show bracket matchups
- `--no-smart-parse` - Disable intelligent parsing
- `--non-interactive` - No prompts (for automation)

## References

- [Official Seeding Policy](https://hello.atlassian.net/wiki/spaces/smash/pages/2789347973/Player+Seeding)
- [Results Database](https://hello.atlassian.net/wiki/spaces/smash/database/5194207434)
