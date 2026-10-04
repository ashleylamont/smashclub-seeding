#!/usr/bin/env bash
# Real Dockerfile, production dependencies, no OAuth/network calls or production data.
set -euo pipefail
smoke_id="smashclub-smoke-${RANDOM}-$$"
smoke_image="${SMOKE_IMAGE:-$smoke_id}"
smoke_logs="${SMOKE_LOG_DIR:-test-results/image}"
mkdir -p "$smoke_logs"
cleanup() {
  status=$?
  docker logs "$smoke_id-app" > "$smoke_logs/server.log" 2>&1 || true
  docker logs "$smoke_id-db" > "$smoke_logs/postgres.log" 2>&1 || true
  docker rm -f "$smoke_id-app" "$smoke_id-db" >/dev/null 2>&1 || true
  docker network rm "$smoke_id" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [[ -z "${SMOKE_IMAGE:-}" ]]; then
  docker build -f deploy/Dockerfile --build-arg "GIT_SHA=$(git rev-parse HEAD)" -t "$smoke_image" .
fi
# An internal network prevents the scheduler or auth from reaching real services.
docker network create --internal "$smoke_id" >/dev/null
docker run -d --name "$smoke_id-db" --network "$smoke_id" --network-alias db \
  -e POSTGRES_PASSWORD=synthetic-image-password postgres:17.10-bookworm >/dev/null
for ((attempt=0; attempt<60; attempt++)); do
  if docker exec "$smoke_id-db" pg_isready -h 127.0.0.1 -U postgres >/dev/null; then break; fi
  sleep 1
done
node scripts/image-upgrade-fixture.mjs | docker exec -i "$smoke_id-db" psql -v ON_ERROR_STOP=1 -U postgres >/dev/null
# Never enable the harness or mount workspace node_modules into this container.
docker run -d --name "$smoke_id-app" --network "$smoke_id" \
  -e DATABASE_URL=postgresql://postgres:synthetic-image-password@db/postgres \
  -e BETTER_AUTH_SECRET=synthetic-image-test-secret-at-least-32-characters \
  -e BETTER_AUTH_URL=http://127.0.0.1:3000 \
  -e CHALLONGE_SCORE_WRITES=false "$smoke_image" >/dev/null
probe() {
  docker exec -i "$smoke_id-app" node --input-type=module < scripts/image-runtime-probe.mjs
}
for ((attempt=0; attempt<60; attempt++)); do
  if docker exec "$smoke_id-app" node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" >/dev/null 2>&1; then break; fi
  sleep 1
done
probe
ledger_before=$(docker exec "$smoke_id-db" psql -U postgres -Atc 'SELECT count(*) FROM drizzle.__drizzle_migrations')
expected=$(node -e "const fs=require('fs');console.log(JSON.parse(fs.readFileSync('packages/db/migrations/meta/_journal.json')).entries.length)")
[[ "$ledger_before" == "$expected" ]]
[[ "$(docker exec "$smoke_id-db" psql -U postgres -Atc "SELECT results_mode FROM tournaments WHERE challonge_slug = 'synthetic-upgrade'")" == final_stage_only ]]
docker restart --time 10 "$smoke_id-app" >/dev/null
for ((attempt=0; attempt<60; attempt++)); do
  if probe > "$smoke_logs/restart-probe.log" 2>&1; then break; fi
  sleep 1
done
probe
[[ "$(docker exec "$smoke_id-db" psql -U postgres -Atc 'SELECT count(*) FROM drizzle.__drizzle_migrations')" == "$ledger_before" ]]
[[ "$(docker inspect --format '{{.Config.User}}' "$smoke_id-app")" == node ]]
echo 'Production image migration, HTTP, assets, auth boundary and restart persistence passed.'
