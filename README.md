# SSBU Tournament Seeding Tool 🎮

Automatically seed Super Smash Bros Ultimate tournaments based on historical player performance.

This tool was created to assist with event planning for
Atlassian's [Smash Club](https://hello.atlassian.net/wiki/spaces/smash/overview).

It was also largely vibe-coded with Rovo Dev CLI, so there may be some quirks.

## Recent Updates

### Bug Fixes (February 2026)
- **Fixed `ModuleNotFoundError: No module named 'tabulate'`**: Updated installation instructions to use `uv sync` instead of manual dependency installation
- **Fixed `UnboundLocalError: cannot access local variable 'YELLOW'`**: Resolved color variable scoping issue in interactive prompts when players have cross-company tournament history
- **Improved CSV file handling**: Better error messages when CSV files are missing or incorrectly named
- **Enhanced documentation**: Added comprehensive data export instructions and troubleshooting guide

## Features

- **Weighted Scoring**: Recent tournaments weighted higher (exponential decay 0.8)
- **Smart Parsing**: Handles messy copy-paste formats from sign-up sheets
- **Fuzzy Matching**: Catches typos and suggests corrections
- **1v1 Priority**: Uses 1v1 results primarily, 2v2 for tiebreaking
- **Dynamic Rookies Adjustment**: Uses transitive performance comparisons to intelligently place rookie bracket
  participants
- **Smart Company Matching**: Auto-merges results when players change companies or have typos (e.g., Optiver/Optus)

## Quick Start

```bash
# Install dependencies
uv sync

# Run seeding (basic)
uv run python main.py --csv results.csv --players main_bracket_list.txt --non-interactive

# Run seeding (with details and bracket)
uv run python main.py --csv results.csv --players player_list.txt --details --bracket --non-interactive

# Run tests
uv run pytest tests/ -v
```

## Data Setup

### Exporting Tournament Results

To use this tool, you need historical tournament data in CSV format. Here's how to export it from the Atlassian Smash Club database:

#### Method 1: From Confluence Results Database

1. **Navigate to the Results Database**:
   - Go to [Results Database](https://hello.atlassian.net/wiki/spaces/smash/database/5194207434)
   - This contains all historical tournament results

2. **Export to CSV**:
   - Click on the "Export" or "Download" button (usually in the top-right)
   - Select "CSV" as the export format
   - Save the file as `results.csv` in your project directory

#### Method 2: Manual CSV Creation

If you need to create the CSV manually, use this exact format:

```csv
Date,Company,Player name,Placement,Format,Tournament
2024-01-15,Atlassian,Samus Aran,1,1v1,Winter Bash 2024
2024-01-15,Atlassian,Fox McCloud,2,1v1,Winter Bash 2024
2024-01-15,Atlassian,Falco Lombardi,3,1v1,Winter Bash 2024
2024-01-15,Atlassian,Samus Aran,1,2v2,Winter Bash 2024 Doubles
2024-01-15,N/A,Ganondorf,1,1v1 Rookies,Winter Bash 2024 Rookies
```

**Required Columns:**
- `Date`: YYYY-MM-DD format
- `Company`: Atlassian, Canva, Optiver, Google, etc. (or N/A)
- `Player name`: Full name as used in tournaments
- `Placement`: Integer placement (1, 2, 3, etc.)
- `Format`: 1v1, 2v2, or "1v1 Rookies"
- `Tournament`: Tournament name/identifier

#### Method 3: Database Query

If you have direct access to the database, you can export using:

```sql
SELECT Date, Company, "Player name", Placement, Format, Tournament 
FROM tournament_results 
ORDER BY Date DESC;
```

### File Structure

After setup, your repository should contain:
```
├── results.csv              # Historical tournament data (required)
├── main_bracket_list.txt    # Current tournament players (required)
├── main.py                  # Main seeding script
└── README.md               # This file
```

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

**Supported Companies:** ATL/Atlassian, CAN/Canva, OPT/Optiver, GOOG/Google, WOW/Woolworths, REL/Relevance AI,
SUS/Susquehanna

**Company Inference:**

- `@` symbol before name → Inferred as Atlassian (e.g., `@Samus Aran`)
- No `@` or brackets → No company (matches against all companies in history)

## Algorithm

### Scoring

- Uses **weighted average** of all 1v1 results with exponential decay (0.8)
- Recent tournaments weighted higher: 1.0, 0.8, 0.64, 0.51...
- Formula: `score = sum(placement × 0.8^index) / sum(0.8^index)`
- 2v2 results used for tiebreaking only

### Rookies Bracket Adjustment

Instead of placing all rookies below the main bracket, we use **transitive performance comparisons** to estimate where
each rookie would place:

1. **Find Connections**: For each rookie, find players they competed against in other tournaments
2. **Compare Performance**: Check how the rookie performed vs. those players
3. **Estimate Placement**: Use the other players' main bracket placements as reference points
4. **Calculate**: `estimated_placement = other_player_main_placement + (performance_delta × 0.5)`
5. **Aggregate**: Use median of all estimates for robustness

**Example**: If a rookie beat Player X in Tournament A, and Player X placed 15th in Tournament B's main bracket, the
rookie is likely stronger than 15th place.

**Fallback**: If no transitive data exists, uses conservative estimate: `max_main × 0.75 + rookie_placement`

**Impact**: Top rookies (1st-3rd) typically place in the middle of the main bracket (e.g., 17th-21st in a 25-person
bracket), rather than being relegated to last place.

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

## Troubleshooting

### Common Issues

#### `ModuleNotFoundError: No module named 'tabulate'`

**Problem**: Dependencies not installed.

**Solution**:
```bash
# Install dependencies first
uv sync

# Then run the script
uv run python main.py --csv results.csv --players main_bracket_list.txt --non-interactive
```

#### `Error: Could not find CSV file: data.csv`

**Problem**: Missing or incorrectly named CSV file.

**Solution**:
- Ensure your CSV file is named `results.csv` (not `data.csv`)
- Place it in the same directory as `main.py`
- Export data following the [Data Setup](#data-setup) instructions above

#### `EOFError: EOF when reading a line`

**Problem**: Script trying to prompt for input in non-interactive environment.

**Solution**: Add the `--non-interactive` flag:
```bash
uv run python main.py --csv results.csv --players main_bracket_list.txt --non-interactive
```

#### `UnboundLocalError: cannot access local variable 'YELLOW'`

**Problem**: Color variable bug (fixed in latest version).

**Solution**: This was a bug that has been fixed. If you encounter it:
1. Pull the latest code from the repository
2. The fix ensures color variables are properly defined in all code paths

#### Player not found in database

**Problem**: Player name variations or company mismatches.

**Solutions**:
- Remove `--non-interactive` to get prompts for fuzzy matching
- Use `--verbose` to see detailed matching information
- Check player name spelling in your player list file
- Verify company abbreviations match the database format

#### No tournament history found

**Problem**: Player is new or name doesn't match database records.

**Expected Behavior**: New players without history will be seeded last automatically.

### Getting Help

If you encounter other issues:

1. **Run with verbose output**:
   ```bash
   uv run python main.py --csv results.csv --players main_bracket_list.txt --verbose
   ```

2. **Check the test suite**:
   ```bash
   uv run pytest tests/ -v
   ```

3. **Verify your data format** matches the CSV format in [Data Setup](#data-setup)

## References

- [Official Seeding Policy](https://hello.atlassian.net/wiki/spaces/smash/pages/2789347973/Player+Seeding)
- [Results Database](https://hello.atlassian.net/wiki/spaces/smash/database/5194207434)
