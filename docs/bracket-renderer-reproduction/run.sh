#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

probe=docs/bracket-renderer-reproduction
web=apps/web
original_board="$web/src/components/LocalTip12Original.tsx"
original_css="$web/src/pages/LocalTip12Original.css"
html="$web/local-tip12-spike.html"
page="$web/src/local-tip12-spike.tsx"
viewer_spec="$web/ui-tests/local-renderer-spike.spec.ts"
tip12_spec="$web/ui-tests/local-tip12-replay.spec.ts"
fixtures="$web/ui-tests/local-renderer-fixtures.ts"
react_spec="$web/ui-tests/local-react-renderer-spike.spec.ts"
files=("$original_board" "$original_css" "$html" "$page" "$viewer_spec" "$tip12_spec" "$fixtures" "$react_spec")
for file in "${files[@]}"; do
  if [[ -e "$file" || -L "$file" ]]; then
    printf 'Scratch path exists: %s\n' "$file" >&2
    exit 1
  fi
done

scratch=$(mktemp -d)
trap 'rm -f -- "${files[@]}"; rm -rf -- "$scratch"' EXIT
export NEMESIS_RENDERER_PROBE_DIR="$scratch"
viewer_tar="$scratch/brackets-viewer.tgz"
curl --fail --silent --show-error \
  'https://registry.npmjs.org/brackets-viewer/-/brackets-viewer-1.9.1.tgz' -o "$viewer_tar"
viewer_hash=$(openssl dgst -sha512 -binary "$viewer_tar" | openssl base64 -A)
test "$viewer_hash" = '+B29mJBsc2G4yWGQAve4HukmETQgm27TshwOKaXJfl3zCKO5yji+fLQdP1/bSWB0LulF9QzBKGPsiWYU8NYcow=='
tar -xzf "$viewer_tar" -C "$scratch"

curl --fail --silent --show-error --get \
  'https://nemesis.ashl.dev/api/trpc/eventOps.snapshot' \
  --data-urlencode 'input={"planId":"42765e65-a0ca-47d8-b22e-b3ace8b520d1"}' \
  -o "$scratch/tip12.json"

# Extract only the historic bracket component and instrument its cards with match IDs.
original=e32d53e
{
  printf '%s\n' "import type { LiveMatch } from '../lib/eventDisplay';" \
    "import type { NativeBracketView } from './EventNightBoard';" \
    "import { CharacterIcons } from './CharacterIcons';"
  git show "$original:$web/src/components/EventNightBoard.tsx" \
    | sed -n '/^export function EventBrackets/,$p' \
    | sed '/className=.*event-bracket-match/i\
                        data-match-id={match.id}
'
} > "$original_board"
git show "$original:$web/src/pages/EventLive.css" > "$original_css"
cp "$probe/tip12.html" "$html"
cp "$probe/tip12.tsx" "$page"
cp "$probe/viewer.spec.ts" "$viewer_spec"
cp "$probe/tip12.spec.ts" "$tip12_spec"
cp "$probe/fixtures.ts" "$fixtures"
cp "$probe/react/viewer.spec.ts" "$react_spec"

cp "$probe/react/package.json" "$probe/react/package-lock.json" "$probe/react/entry.tsx" "$scratch/"
npm ci --ignore-scripts --no-audit --no-fund --prefix "$scratch"
repo="$PWD"
(
  cd "$scratch"
  npm exec --yes --package esbuild@0.25.12 -- esbuild entry.tsx --bundle \
    --alias:nemesis-probe-fixtures="$repo/$fixtures" \
    --alias:nemesis-bracket-side="$repo/$web/src/lib/eventBracket.ts" \
    --define:process.env.NODE_ENV='"development"' --outfile=react-viewer.js
)

pnpm --filter @smashclub/web test:ui \
  local-renderer-spike.spec.ts local-tip12-replay.spec.ts local-react-renderer-spike.spec.ts "$@"
