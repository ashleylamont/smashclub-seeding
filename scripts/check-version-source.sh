#!/usr/bin/env bash
set -euo pipefail

# The pinned Changesets action resets to the event SHA before versioning.
if ! [[ "$GITHUB_SHA" =~ ^[0-9a-f]{40}$ ]] || [[ "$(git rev-parse HEAD)" != "$GITHUB_SHA" ]]; then
  echo 'Version checkout must match the full trigger SHA.' >&2
  exit 1
fi

: "${GH_TOKEN:?Version preflight requires a read token}"
if ! main_sha="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/main" --jq '.object.sha')" ||
  ! [[ "$main_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo 'Could not verify the current main commit before versioning.' >&2
  exit 1
fi

if [[ "$main_sha" != "$GITHUB_SHA" ]]; then
  echo 'Main advanced after this trigger. Pending Changesets are left for a current run.'
  if [[ "$GITHUB_EVENT_NAME" == 'workflow_dispatch' ]]; then
    echo 'Run Version Nemesis again on main to request an immediate version.'
  fi
  echo 'ready=false' >> "$GITHUB_OUTPUT"
else
  echo 'ready=true' >> "$GITHUB_OUTPUT"
fi
