#!/usr/bin/env bash
# Run from an uploaded release bundle. Secrets stay in the host's .env.
set -Eeuo pipefail
umask 077

if [[ $# -lt 1 || $# -gt 2 || ( $# -eq 2 && $2 != --code-rollback ) ]]; then
  printf 'Usage: bash scripts/deploy.sh <release.env> [--code-rollback]\n' >&2
  exit 2
fi
task_root=${WISDOM_TREE_DIR:-/opt/wisdom-tree}
[[ $task_root == /* && $task_root != / ]] || { printf 'WISDOM_TREE_DIR must be an absolute application directory.\n' >&2; exit 2; }
task_release_file=$(realpath -- "$1")
task_bundle=$(dirname -- "$task_release_file")
task_rollback=${2:-}

validate_release() {
  local candidate=$1
  [[ -f $candidate ]] || return 1
  # Only non-secret immutable release metadata is accepted; never source it.
  awk '
    /^RELEASE_ID=[a-f0-9]+$/ { if (length(substr($0,12)) != 40 || seen_id++) exit 1; next }
    /^(API_IMAGE|WEB_IMAGE|DB_IMAGE|CADDY_IMAGE)=ghcr\.io\/[a-z0-9][a-z0-9\/_.-]*(@sha256:[a-f0-9]+|:[a-f0-9]+)$/ {
      split($0, pair, "="); if (seen[pair[1]]++) exit 1;
      if (pair[2] ~ /@sha256:/) { split(pair[2], hash, "@sha256:"); if (length(hash[2]) != 64) exit 1 }
      else { split(pair[2], hash, ":"); if (length(hash[2]) != 40) exit 1 }
      next
    }
    { exit 1 }
    END {
      if ((NR != 3 && NR != 5) || seen_id != 1 || seen["API_IMAGE"] != 1 || seen["WEB_IMAGE"] != 1) exit 1;
      if (NR == 3 && (seen["DB_IMAGE"] || seen["CADDY_IMAGE"])) exit 1;
      if (NR == 5 && (seen["DB_IMAGE"] != 1 || seen["CADDY_IMAGE"] != 1)) exit 1;
    }
  ' "$candidate"
}
validate_release "$task_release_file" || { printf 'Invalid release metadata; use a commit SHA and immutable GHCR images.\n' >&2; exit 2; }
task_release_id=$(sed -n 's/^RELEASE_ID=//p' "$task_release_file")
task_release_dir=$task_root/releases/$task_release_id
[[ -f $task_root/.env ]] || { printf 'Server .env is missing; run bootstrap-host.sh first.\n' >&2; exit 2; }
[[ -f $task_bundle/compose.deploy.yml && -f $task_bundle/Caddyfile && -f $task_bundle/scripts/deploy.sh && -f $task_bundle/scripts/rollback.sh ]] || { printf 'The release bundle is incomplete.\n' >&2; exit 2; }
command -v docker >/dev/null
command -v flock >/dev/null
command -v curl >/dev/null
docker compose version >/dev/null
mkdir -p "$task_root/releases" "$task_root/backups"
chmod 700 "$task_root" "$task_root/backups"
chmod 600 "$task_root/.env"
exec 9>"$task_root/.deploy.lock"
flock -n 9 || { printf 'Another release is running.\n' >&2; exit 1; }

task_old_id=''
task_old_dir=''
if [[ -f $task_root/.release.env ]]; then
  validate_release "$task_root/.release.env" || { printf 'Current release metadata is invalid.\n' >&2; exit 1; }
  task_old_id=$(sed -n 's/^RELEASE_ID=//p' "$task_root/.release.env")
  task_old_dir=$task_root/releases/$task_old_id
  [[ -f $task_old_dir/compose.deploy.yml && -f $task_old_dir/.release.env ]] || { printf 'Current release bundle is missing; refusing to replace it.\n' >&2; exit 1; }
fi
# Existing immutable bundles must match; never overwrite a successful release.
if [[ -d $task_release_dir ]]; then
  for task_file in compose.deploy.yml Caddyfile scripts/deploy.sh scripts/rollback.sh; do
    cmp -s "$task_bundle/$task_file" "$task_release_dir/$task_file" || { printf 'Release bundle differs from the already saved commit.\n' >&2; exit 1; }
  done
  cmp -s "$task_release_file" "$task_release_dir/.release.env" || { printf 'Image metadata differs from the already saved commit.\n' >&2; exit 1; }
else
  task_staging=$(mktemp -d "$task_root/releases/.prepare.XXXXXXXX")
  mkdir -p "$task_staging/scripts"
  cp -- "$task_bundle/compose.deploy.yml" "$task_bundle/Caddyfile" "$task_staging/"
  cp -- "$task_bundle/scripts/deploy.sh" "$task_bundle/scripts/rollback.sh" "$task_staging/scripts/"
  cp -- "$task_release_file" "$task_staging/.release.env"
  mv -- "$task_staging" "$task_release_dir"
fi

compose_for() {
  local release=$1
  shift
  # Shell variables must not override the reviewed release or persistent secrets.
  env -u API_IMAGE -u WEB_IMAGE -u DB_IMAGE -u CADDY_IMAGE -u RELEASE_ID -u POSTGRES_PASSWORD \
    -u API_KEY_ENCRYPTION_KEY -u PUBLIC_ORIGIN -u SITE_ADDRESS -u ACME_EMAIL \
    -u GITHUB_CLIENT_ID -u GITHUB_CLIENT_SECRET -u LINUXDO_CLIENT_ID -u LINUXDO_CLIENT_SECRET \
    -u ADMIN_USERNAME -u ADMIN_PASSWORD -u LOG_LEVEL -u DB_POOL_MAX \
    docker compose --project-name wisdom-tree --project-directory "$release" --env-file "$task_root/.env" --env-file "$release/.release.env" -f "$release/compose.deploy.yml" "$@"
}
compose() { compose_for "$task_release_dir" "$@"; }

task_transition=0
task_dump_tmp=''
task_env_tmp=''
task_home_tmp=''
cleanup() {
  [[ -z $task_dump_tmp ]] || rm -f -- "$task_dump_tmp"
  [[ -z $task_env_tmp ]] || rm -f -- "$task_env_tmp"
  [[ -z $task_home_tmp ]] || rm -f -- "$task_home_tmp"
}
on_error() {
  local status=$?
  trap - ERR
  set +e
  if [[ $task_transition -eq 1 && -n $task_old_dir ]]; then
    printf 'Release failed; restoring the previous PostgreSQL 17 and application images. Database changes are retained.\n' >&2
    if compose_for "$task_old_dir" up -d --wait --wait-timeout 120 db && \
       compose_for "$task_old_dir" up -d --wait --wait-timeout 180 api web caddy; then
      printf 'Previous database and application services are healthy.\n' >&2
    else
      printf 'Previous stack restart failed; inspect database health and migration compatibility.\n' >&2
    fi
  elif [[ $task_transition -eq 1 ]]; then
    compose stop api >/dev/null
    printf 'Initial release failed. Database and protected backups are retained; no previous release exists.\n' >&2
  fi
  exit "$status"
}
trap cleanup EXIT
trap on_error ERR

# Invalid interpolation/credentials fail before stopping the current API.
compose config --quiet
compose pull api web db caddy

require_postgres_17() {
  local release=$1
  local version
  # Override the entrypoint: --version never initializes or edits the data volume.
  version=$(compose_for "$release" run --rm --no-deps --entrypoint postgres db --version)
  if ! printf '%s\n' "$version" | grep -Eq '^postgres \(PostgreSQL\) 17([. ]|$)'; then
    printf 'Only PostgreSQL 17 images are supported; major-version changes are refused.\n' >&2
    return 1
  fi
}
require_postgres_17 "$task_release_dir"
task_backup_release=$task_release_dir
if [[ -n $task_old_dir ]]; then
  require_postgres_17 "$task_old_dir"
  # Inspect the saved stack without recreating its database before the backup.
  task_old_db_container=$(compose_for "$task_old_dir" ps --quiet db)
  [[ $task_old_db_container =~ ^[a-f0-9]{12,64}$ ]] || { printf 'The previous database container is not running.\n' >&2; false; }
  task_old_db_health=$(docker inspect --format '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$task_old_db_container")
  [[ $task_old_db_health == 'true healthy' ]] || { printf 'The previous database is not healthy; upgrade was not started.\n' >&2; false; }
  task_backup_release=$task_old_dir
  task_transition=1
  compose_for "$task_old_dir" stop api
else
  # No established release exists yet, so the initial database must start first.
  compose up -d --wait --wait-timeout 120 db
  task_transition=1
  compose stop api
fi

task_backup_id=$(date -u +%Y%m%dT%H%M%SZ)-$task_release_id-$$
task_dump=$task_root/backups/$task_backup_id.dump
task_env_backup=$task_root/backups/$task_backup_id.env
[[ ! -e $task_dump && ! -e $task_env_backup ]]
task_dump_tmp=$(mktemp "$task_root/backups/.dump.XXXXXXXX")
task_env_tmp=$(mktemp "$task_root/backups/.env.XXXXXXXX")
compose_for "$task_backup_release" exec -T db pg_dump -U wisdom -d wisdom -Fc >"$task_dump_tmp"
[[ -s $task_dump_tmp ]]
# Expand the complete archive, validating compressed data as well as the TOC.
compose_for "$task_backup_release" exec -T db pg_restore --file=/dev/null <"$task_dump_tmp"
cp -- "$task_root/.env" "$task_env_tmp"
chmod 600 "$task_dump_tmp" "$task_env_tmp"
mv -- "$task_dump_tmp" "$task_dump"
task_dump_tmp=''
mv -- "$task_env_tmp" "$task_env_backup"
task_env_tmp=''
printf 'Protected database/configuration backup saved: %s\n' "$task_backup_id"

if [[ -n $task_old_dir ]]; then
  # Only now may Compose replace the old database container/image.
  compose up -d --wait --wait-timeout 120 db
fi

if [[ $task_rollback != --code-rollback ]]; then
  compose run --rm --no-deps api node dist/migrate.js
fi
task_has_admin=$(compose exec -T db psql -U wisdom -d wisdom -At -v ON_ERROR_STOP=1 -c "SELECT EXISTS(SELECT 1 FROM users WHERE role='admin' AND status='active');")
case "$task_has_admin" in
  t) ;;
  f) compose run --rm --no-deps api node dist/admin-cli.js ;;
  *) printf 'Unable to determine whether an administrator exists.\n' >&2; false ;;
esac
compose up -d --wait --wait-timeout 180 api web caddy

task_origin=$(sed -n 's/^PUBLIC_ORIGIN=//p' "$task_root/.env")
[[ $task_origin =~ ^https://[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$ ]] || { printf 'PUBLIC_ORIGIN must be an unquoted HTTPS domain origin.\n' >&2; false; }
curl --fail --silent --show-error --retry 8 --retry-delay 3 --retry-all-errors --connect-timeout 5 --max-time 15 "$task_origin/health" >/dev/null
task_home_tmp=$(mktemp)
curl --fail --silent --show-error --connect-timeout 5 --max-time 15 "$task_origin/" >"$task_home_tmp"
if ! grep -qi '<!doctype html' "$task_home_tmp"; then
  printf 'The public homepage did not return the frontend HTML.\n' >&2
  false
fi
rm -f -- "$task_home_tmp"
task_home_tmp=''
task_headers=$(curl --silent --show-error --connect-timeout 5 --max-time 15 --dump-header - --output /dev/null "http://${task_origin#https://}/")
printf '%s\n' "$task_headers" | grep -Eq '^HTTP/[0-9.]+ (301|308) '
printf '%s\n' "$task_headers" | tr -d '\r' | grep -Fiqx "Location: $task_origin/"

if [[ -n ${DEPLOY_SMOKE_API_KEY:-} ]]; then
  export DEPLOY_SMOKE_API_KEY DEPLOY_SMOKE_MODEL
  DEPLOY_RELEASE_ID=$task_release_id
  export DEPLOY_RELEASE_ID
  compose run --rm --no-deps -e DEPLOY_SMOKE_API_KEY -e DEPLOY_SMOKE_MODEL -e DEPLOY_RELEASE_ID api node --input-type=module -e '
    const response = await fetch(`${process.env.PUBLIC_ORIGIN}/v1/chat/completions`, {
      method: "POST", signal: AbortSignal.timeout(30000),
      headers: {"Content-Type":"application/json", Authorization:`Bearer ${process.env.DEPLOY_SMOKE_API_KEY}`, "Idempotency-Key":`deployment-${process.env.DEPLOY_RELEASE_ID}`},
      body: JSON.stringify({model:process.env.DEPLOY_SMOKE_MODEL || "gpt-5.6-luna",messages:[{role:"user",content:"deployment stream check"}],stream:true})
    });
    if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream")) throw new Error("Public SSE response failed");
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let output = ""; let chunks = 0;
    while (true) { const next = await reader.read(); if (next.done) break; chunks++; output += decoder.decode(next.value,{stream:true}); if (output.length > 2_000_000) throw new Error("Unexpectedly large stream"); }
    output += decoder.decode();
    if (!output.includes("data: [DONE]") || !output.includes("chat.completion.chunk") || chunks < 1) throw new Error("Incomplete public SSE response");
    console.log("HTTPS reverse-proxy SSE check passed.");
  '
else
  printf 'HTTPS health, homepage and HTTP redirect passed. SSE smoke was skipped: no DEPLOY_SMOKE_API_KEY was supplied.\n'
fi

# Record only a fully healthy release. Metadata files contain no credentials.
if [[ -n $task_old_id && $task_old_id != "$task_release_id" ]]; then
  cp -- "$task_root/.release.env" "$task_root/.previous-release.env.tmp"
  mv -- "$task_root/.previous-release.env.tmp" "$task_root/.previous-release.env"
fi
cp -- "$task_release_dir/.release.env" "$task_root/.release.env.tmp"
mv -- "$task_root/.release.env.tmp" "$task_root/.release.env"
task_transition=0
printf 'Release %s is live at %s\n' "$task_release_id" "$task_origin"
