#!/usr/bin/env bash
#
# Fetch SSBU head icons from SSBWiki and pack them into a zip.
#
#   ./fetch-icons.sh                      # -> smashclub-character-icons.zip
#   ./fetch-icons.sh -o /tmp/icons.zip    # somewhere else
#   ./fetch-icons.sh --keep-dir ./icons   # also leave the loose PNGs behind
#
# Unzip the result into apps/web/public/characters/ and the icons appear
# beside player names. Filenames are the roster slugs, so no renaming is
# needed:
#
#   unzip -o smashclub-character-icons.zip -d apps/web/public/characters/
#
# Needs only bash, curl and python3 (stdlib) — python3 is used for JSON
# parsing and, if the `zip` binary is missing, for zipping.
#
# The wiki's file names are inconsistent and change, so this does not guess
# at them: it asks the MediaWiki API for the category's actual members,
# normalises each title, and matches it against the roster below. Anything
# it cannot match is listed at the end rather than silently skipped.
#
# The roster mirrors packages/shared/src/characters.ts — the slugs here MUST
# match the slugs there, since that is what names the file the UI asks for.
#
# These are Nintendo's assets, used the way every other fan bracket site uses
# them. Don't commit the output; apps/web/public/characters/*.png is ignored.

set -euo pipefail

# Byte-wise, ASCII-only sed/tr behaviour regardless of the caller's locale.
export LC_ALL=C

API="${SSBWIKI_API:-https://www.ssbwiki.com/api.php}"
CATEGORY="${SSBWIKI_CATEGORY:-Category:Head icons (SSBU)}"
UA="smashclub-seeding icon fetcher (one-off; https://github.com/ashleylamont/smashclub-seeding)"

OUTPUT="smashclub-character-icons.zip"
KEEP_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    -o|--output) OUTPUT="${2:?--output needs a path}"; shift 2 ;;
    --keep-dir)  KEEP_DIR="${2:?--keep-dir needs a path}"; shift 2 ;;
    -h|--help)   sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1 (try --help)" >&2; exit 2 ;;
  esac
done

for tool in curl python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: $tool is required but not installed." >&2; exit 1; }
done

# ---------------------------------------------------------------------------
# Roster: slug|Display Name|alternate;spellings
# ---------------------------------------------------------------------------
ROSTER=$(cat <<'ROSTER_EOF'
mario|Mario|
donkey-kong|Donkey Kong|
link|Link|
samus|Samus|
dark-samus|Dark Samus|
yoshi|Yoshi|
kirby|Kirby|
fox|Fox|
pikachu|Pikachu|
luigi|Luigi|
ness|Ness|
captain-falcon|Captain Falcon|
jigglypuff|Jigglypuff|
peach|Peach|
daisy|Daisy|
bowser|Bowser|
ice-climbers|Ice Climbers|
sheik|Sheik|
zelda|Zelda|
dr-mario|Dr. Mario|Dr Mario;DrMario
pichu|Pichu|
falco|Falco|
marth|Marth|
lucina|Lucina|
young-link|Young Link|
ganondorf|Ganondorf|
mewtwo|Mewtwo|
roy|Roy|
chrom|Chrom|
mr-game-and-watch|Mr. Game & Watch|Mr Game & Watch;GameAndWatch;Game & Watch
meta-knight|Meta Knight|
pit|Pit|
dark-pit|Dark Pit|
zero-suit-samus|Zero Suit Samus|
wario|Wario|
snake|Snake|
ike|Ike|
pokemon-trainer|Pokémon Trainer|Pokemon Trainer;PokemonTrainer
squirtle|Squirtle|
ivysaur|Ivysaur|
charizard|Charizard|
diddy-kong|Diddy Kong|
lucas|Lucas|
sonic|Sonic|
king-dedede|King Dedede|
olimar|Olimar|
lucario|Lucario|
rob|R.O.B.|ROB;R.O.B
toon-link|Toon Link|
wolf|Wolf|
villager|Villager|
mega-man|Mega Man|Megaman
wii-fit-trainer|Wii Fit Trainer|
rosalina-and-luma|Rosalina & Luma|Rosalina;RosalinaAndLuma;Rosalina and Luma
little-mac|Little Mac|
greninja|Greninja|
mii-brawler|Mii Brawler|
mii-swordfighter|Mii Swordfighter|
mii-gunner|Mii Gunner|
palutena|Palutena|
pac-man|Pac-Man|PacMan;Pac Man
robin|Robin|
shulk|Shulk|
bowser-jr|Bowser Jr.|Bowser Jr;BowserJr
duck-hunt|Duck Hunt|
ryu|Ryu|
ken|Ken|
cloud|Cloud|
corrin|Corrin|
bayonetta|Bayonetta|
inkling|Inkling|
ridley|Ridley|
simon|Simon|
richter|Richter|
king-k-rool|King K. Rool|King K Rool;KingKRool
isabelle|Isabelle|
incineroar|Incineroar|
piranha-plant|Piranha Plant|
joker|Joker|
hero|Hero|
banjo-and-kazooie|Banjo & Kazooie|Banjo;BanjoAndKazooie;Banjo and Kazooie
terry|Terry|
byleth|Byleth|
min-min|Min Min|
steve|Steve|
sephiroth|Sephiroth|
pyra|Pyra|
mythra|Mythra|
kazuya|Kazuya|
sora|Sora|
ROSTER_EOF
)

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
ICONS="$WORK/characters"
mkdir -p "$ICONS"

# ---------------------------------------------------------------------------
# Strip everything that varies between a wiki file name and a character name —
# the File: prefix, the Head/SSBU/Icon decorations, punctuation and case — so
# "File:HeadSSBUDarkSamus.png" and "Dark Samus" both reduce to "darksamus".
# ---------------------------------------------------------------------------
normalize() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/^file://; s/\.(png|jpg|jpeg|gif|svg)$//; s/head|icon|ssbu|stock//g; s/[^a-z0-9]//g'
}

# ---------------------------------------------------------------------------
# Every file in the category, as "normalised-key<TAB>url".
# ---------------------------------------------------------------------------
echo "Listing ${CATEGORY} …"
CATALOG="$WORK/catalog.tsv"
: > "$CATALOG"
cont=""
pages=0

while :; do
  url="${API}?action=query&format=json&formatversion=2&generator=categorymembers&gcmtype=file&gcmlimit=500&prop=imageinfo&iiprop=url"
  url="${url}&gcmtitle=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$CATEGORY")"
  [ -n "$cont" ] && url="${url}&gcmcontinue=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$cont")"

  if ! curl -fsSL -A "$UA" "$url" -o "$WORK/page.json"; then
    echo "error: the wiki API request failed. Check network access to ${API}." >&2
    exit 1
  fi

  # Titles and URLs to stdout; the continuation token to its own file.
  python3 - "$WORK/page.json" "$WORK/cont" <<'PY' >> "$WORK/raw.tsv"
import json, sys
with open(sys.argv[1], encoding='utf-8') as handle:
    data = json.load(handle)
if 'error' in data:
    sys.exit(f"wiki API error: {data['error'].get('info', data['error'])}")
for page in (data.get('query') or {}).get('pages') or []:
    info = (page.get('imageinfo') or [{}])[0]
    if info.get('url'):
        print(f"{page['title']}\t{info['url']}")
with open(sys.argv[2], 'w', encoding='utf-8') as handle:
    handle.write((data.get('continue') or {}).get('gcmcontinue', ''))
PY

  cont=$(cat "$WORK/cont")
  pages=$((pages + 1))
  [ -z "$cont" ] && break
  [ "$pages" -gt 20 ] && { echo "warning: stopping after 20 pages of results." >&2; break; }
done

[ -s "$WORK/raw.tsv" ] || { echo "error: the category returned no files. Has it been renamed?" >&2; exit 1; }
echo "  $(wc -l < "$WORK/raw.tsv" | tr -d ' ') files in the category."

# First match wins: the category also holds variant icons whose names extend
# the base one, and the plain icon sorts first.
while IFS=$'\t' read -r title url; do
  [ -n "$title" ] || continue
  printf '%s\t%s\n' "$(normalize "$title")" "$url"
done < "$WORK/raw.tsv" > "$CATALOG"

# ---------------------------------------------------------------------------
# Match each roster entry and download it.
# ---------------------------------------------------------------------------
written=0
missing=""

while IFS='|' read -r slug name aka; do
  [ -n "${slug:-}" ] || continue

  # Try the display name, the slug, then any alternate spelling.
  url=""
  candidates="$name
$slug"
  if [ -n "${aka:-}" ]; then
    candidates="$candidates
$(printf '%s' "$aka" | tr ';' '\n')"
  fi

  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    key=$(normalize "$candidate")
    [ -n "$key" ] || continue
    url=$(awk -F'\t' -v k="$key" '$1 == k { print $2; exit }' "$CATALOG")
    [ -n "$url" ] && break
  done <<EOF
$candidates
EOF

  if [ -z "$url" ]; then
    missing="$missing $name"
    continue
  fi

  if curl -fsSL -A "$UA" "$url" -o "$ICONS/$slug.png"; then
    written=$((written + 1))
    printf '  ok  %-22s -> %s.png\n' "$name" "$slug"
  else
    rm -f "$ICONS/$slug.png"
    missing="$missing $name"
    printf '  !!  %-22s download failed\n' "$name"
  fi
done <<EOF
$ROSTER
EOF

[ "$written" -gt 0 ] || { echo "error: nothing downloaded; not writing a zip." >&2; exit 1; }

# ---------------------------------------------------------------------------
# Pack. Files sit at the root of the zip so it unzips straight into
# apps/web/public/characters/.
# ---------------------------------------------------------------------------
OUTPUT_ABS=$(python3 -c 'import os,sys;print(os.path.abspath(sys.argv[1]))' "$OUTPUT")
rm -f "$OUTPUT_ABS"

if command -v zip >/dev/null 2>&1; then
  (cd "$ICONS" && zip -q -j "$OUTPUT_ABS" ./*.png)
else
  python3 - "$ICONS" "$OUTPUT_ABS" <<'PY'
import os, sys, zipfile
source, target = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
    for name in sorted(os.listdir(source)):
        if name.endswith('.png'):
            archive.write(os.path.join(source, name), name)
PY
fi

if [ -n "$KEEP_DIR" ]; then
  mkdir -p "$KEEP_DIR"
  cp "$ICONS"/*.png "$KEEP_DIR"/
  echo "Loose PNGs copied to $KEEP_DIR/"
fi

total=$(printf '%s\n' "$ROSTER" | grep -c '|' || true)
echo
echo "$written/$total icons -> $OUTPUT_ABS"
if [ -n "$missing" ]; then
  echo "Unmatched:$missing"
  echo "  (add an alternate spelling to the roster in this script and in"
  echo "   packages/shared/src/characters.ts, or drop those files in by hand)"
fi
