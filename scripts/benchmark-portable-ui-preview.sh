#!/usr/bin/env bash
set -euo pipefail

ordinal=${PORTABLE_PREVIEW_ORDINAL:?Missing portable shard number}
first=${PORTABLE_PREVIEW_FIRST:?Missing first serving mode}
attempt=${GITHUB_RUN_ATTEMPT:-1}
[[ "$ordinal" =~ ^[1-3]$ && "$first" =~ ^(dev|built)$ && "$attempt" =~ ^[1-9][0-9]*$ ]]
second=built
if [[ "$first" == built ]]; then second=dev; fi
if (( attempt % 2 == 0 )); then
  initial=$first
  first=$second
  second=$initial
fi

output=${PORTABLE_PREVIEW_OUTPUT:-"$PWD/portable-ui-preview-results"}
config=apps/web/playwright.ui.config.ts
benchmark_base=apps/web/playwright.ui.benchmark-base.ts
html=apps/web/playwright-report/ui
captures=apps/web/ui-test-results
for path in "$output/dev" "$output/built" "$benchmark_base" "$html" "$captures"; do
  if [[ -e "$path" ]]; then
    printf 'Start the benchmark in a fresh checkout. Found %s.\n' "$path" >&2
    exit 1
  fi
done
mkdir -p "$output"
original=$(mktemp)
cp "$config" "$original"
restore() {
  cp "$original" "$config"
  rm -f "$original" "$benchmark_base"
}
trap restore EXIT
printf '%s\n%s\n' "$first" "$second" > "$output/arm-order.txt"
node --version | tee "$output/node-version.txt"

now_ms() {
  node -p 'Date.now()'
}

run_timed() {
  local dir=$1 step=$2 start finish result=0
  shift 2
  start=$(now_ms)
  "$@" 2>&1 | tee "$dir/$step.log" || result=$?
  finish=$(now_ms)
  printf '%s\n' "$((finish - start))" | tee "$dir/$step-ms.txt"
  return "$result"
}

use_built_preview() {
  cp "$original" "$benchmark_base" || return 1
  cat > "$config" <<'TYPESCRIPT'
import { defineConfig } from '@playwright/test';
import base from './playwright.ui.benchmark-base';

const server = base.webServer;
if (!server || Array.isArray(server)) throw new Error('Expected one fixture web server.');
const port = Number(process.env.UI_PORT ?? 3411);

export default defineConfig({
  ...base,
  webServer: {
    ...server,
    command: `pnpm preview --host 127.0.0.1 --port ${port} --strictPort`,
  },
});
TYPESCRIPT
}

run_arm() {
  local mode=$1 dir="$output/$1" result=0
  mkdir -p "$dir" || return 1
  if [[ "$mode" == built ]]; then
    run_timed "$dir" build pnpm --filter @smashclub/web exec vite build || result=$?
    if (( result == 0 )); then use_built_preview || result=$?; fi
  else
    printf '0\n' > "$dir/build-ms.txt" || return 1
  fi
  if (( result == 0 )); then
    run_timed "$dir" browser env GITHUB_OUTPUT="$dir/gates.txt" \
      node scripts/run-ui-platform.mjs portable "$ordinal/3" || result=$?
  fi
  cp "$original" "$config" || return 1
  if [[ -d "$html" ]]; then mv "$html" "$dir/report" || return 1; fi
  if [[ -d "$captures" ]]; then mv "$captures" "$dir/captures" || return 1; fi
  printf '%s\n' "$result" > "$dir/exit-code.txt" || return 1
  if [[ -f "$dir/browser-ms.txt" ]]; then
    printf '%s\n' "$(($(cat "$dir/build-ms.txt") + $(cat "$dir/browser-ms.txt")))" \
      > "$dir/total-ms.txt" || return 1
  fi
  return "$result"
}

failed=0
run_arm "$first" || failed=1
run_arm "$second" || failed=1
if (( failed != 0 )); then exit 1; fi
for mode in dev built; do
  grep -Eq '^ui_case_set=[a-f0-9]{64}$' "$output/$mode/gates.txt"
  grep -Eq '^ui_portable_plan=[a-f0-9]{64}$' "$output/$mode/gates.txt"
  grep -Fxq "ui_portable_shard=$ordinal/3" "$output/$mode/gates.txt"
done
cmp "$output/dev/gates.txt" "$output/built/gates.txt"
printf 'Both modes passed the same exact case and shard gates.\n' | tee "$output/gate-comparison.txt"
