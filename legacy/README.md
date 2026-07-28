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

# Run placement-based seeding (basic)
uv run python main.py --csv results.csv --players main_bracket_list.txt --non-interactive

# Run Glicko-2 seeding from an existing match CSV
uv run python main.py --use-glicko --matches-csv matches.csv --players main_bracket_list.txt --non-interactive

# Fetch one Challonge tournament directly into Glicko-2
uv run python main.py --use-glicko --fetch-challonge corporate_weekly --players main_bracket_list.txt --non-interactive

# Fetch and combine multiple Challonge tournaments into one Glicko-2 dataset
uv run python main.py --use-glicko --fetch-challonge weekly1 weekly2 https://challonge.com/monthly_finals --players main_bracket_list.txt --non-interactive

# Load Challonge tournaments from the default challonge_tournaments.txt file
uv run python main.py --use-glicko --players main_bracket_list.txt --non-interactive

# Or use an explicit Challonge config file
uv run python main.py --use-glicko --fetch-challonge-file challonge_tournaments.txt --players main_bracket_list.txt --non-interactive

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
# Default placement-based seeding (smart parsing + interactive prompts)
python main.py --csv data.csv --players list.txt

# With details and bracket
python main.py --csv data.csv --players list.txt --details --bracket

# Non-interactive (for scripts)
python main.py --csv data.csv --players list.txt --non-interactive
```

### Glicko-2 Prototype Usage

```bash
# Use an existing matches.csv file
uv run python main.py --use-glicko --matches-csv matches.csv --players list.txt --non-interactive

# Fetch a single Challonge tournament and seed from it immediately
uv run python main.py --use-glicko --fetch-challonge corporate_weekly --players list.txt --non-interactive

# Fetch multiple Challonge tournaments and combine them into one in-memory dataset
uv run python main.py --use-glicko --fetch-challonge weekly1 weekly2 https://challonge.com/monthly_finals --players list.txt --non-interactive

# Persist the fetched/combined Challonge data for reuse
uv run python main.py --use-glicko --fetch-challonge weekly1 weekly2 --matches-csv combined_matches.csv --players list.txt --non-interactive

# Load tournaments from the default challonge_tournaments.txt file automatically
uv run python main.py --use-glicko --players list.txt --non-interactive

# Load tournaments from a config file and optionally add extra ones inline
uv run python main.py --use-glicko --fetch-challonge-file challonge_tournaments.txt --fetch-challonge special_event --matches-csv combined_matches.csv --players list.txt --non-interactive
```

### Challonge Tournament Config File

Create a text file named `challonge_tournaments.txt` in the repo root to have it picked up automatically, or point to another file with `--fetch-challonge-file`.

Example `challonge_tournaments.txt`:

```text
# One tournament per line
weekly1
weekly2
https://challonge.com/monthly_finals
```

Rules:
- Blank lines are ignored
- Lines beginning with `#` are treated as comments
- You can use slugs, full URLs, or mix both
- `challonge_tournaments.txt` is used automatically when present and `--use-glicko` is enabled
- `--fetch-challonge-file` can be combined with `--fetch-challonge`
- An explicit `--fetch-challonge-file` overrides the default file path

A starter template is included at `challonge_tournaments.txt.example`.

### Challonge Setup Notes

1. Copy `.env.example` to `.env`.
2. Fill in `CHALLONGE_USERNAME` and `CHALLONGE_API_KEY`.
3. Use either Challonge slugs (for example `weekly1`) or full URLs.
4. Only completed matches are imported.
5. Matches with missing `player1_id` or `player2_id` are skipped automatically (common for byes/DQs).
6. If you omit `--matches-csv` while using `--fetch-challonge`, the tool creates a temporary CSV automatically and deletes it after the run.
7. If you pass multiple values to `--fetch-challonge`, they are combined into a single `matches.csv` dataset and sorted chronologically before Glicko processing.
8. If `challonge_tournaments.txt` exists, it is used automatically with `--use-glicko`; you can override it with `--fetch-challonge-file`.
9. You can also add more tournaments inline with `--fetch-challonge` in the same command.

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

- `--csv FILE` - Historical placement-results CSV for the legacy seeding system
- `--use-glicko` - Enable the Glicko-2 prototype instead of placement-based seeding
- `--matches-csv FILE` - Historical match-results CSV, or the destination file when used with `--fetch-challonge`
- `--fetch-challonge ID [ID ...]` - Fetch one or more Challonge tournaments (slug or URL) and convert them into the Glicko `matches.csv` schema
- `--fetch-challonge-file FILE` - Load Challonge tournament slugs/URLs from a text file, one per line
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
- Ensure your CSV file path is correct for the selected mode:
  - legacy seeding: `--csv results.csv`
  - Glicko seeding: `--matches-csv matches.csv`
- Place the file in the expected location, or pass an explicit path
- Export or fetch data following the [Data Setup](#data-setup) instructions above

#### `Error importing Challonge tournament: ...`

**Problem**: The Challonge import failed.

**Common causes**:
- `.env` is missing `CHALLONGE_USERNAME` or `CHALLONGE_API_KEY`
- The Challonge tournament slug/URL is incorrect
- The API returned a 401 or 404

**Solution**:
```bash
cp .env.example .env
# then edit .env and add your real credentials

uv run python main.py --use-glicko --fetch-challonge your_tournament --players main_bracket_list.txt --non-interactive
```

If you are importing multiple tournaments, verify each slug/URL individually first.
If you are using `--fetch-challonge-file`, also confirm the file path is correct and that each tournament appears on its own line.

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

4. **For Challonge/Glicko workflows**, try writing the fetched data to disk so you can inspect it directly:
   ```bash
   uv run python main.py --use-glicko --fetch-challonge weekly1 weekly2 --matches-csv combined_matches.csv --players main_bracket_list.txt --non-interactive
   ```

## References

- [Official Seeding Policy](https://hello.atlassian.net/wiki/spaces/smash/pages/2789347973/Player+Seeding)
- [Results Database](https://hello.atlassian.net/wiki/spaces/smash/database/5194207434)
