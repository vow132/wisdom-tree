#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
if [[ $# -ne 2 || $2 != --replace-database ]]; then
  printf 'Usage: bash scripts/restore.sh <backup.dump> --replace-database\n' >&2
  exit 2
fi
task_root=$(pwd -P)
task_dump=$(realpath -- "$1")
[[ -f $task_dump && -s $task_dump && $task_dump == *.dump && ! -L $1 ]] || { printf 'Supply a nonempty regular database dump.\n' >&2; exit 2; }
task_base=${task_dump%.dump}
task_uploads=$task_base.uploads.tar.gz
task_saved_env=$task_base.env
task_env=$task_root/.env
[[ -f $task_env && ! -L $task_env ]] || { printf 'Run from the application directory containing its protected .env.\n' >&2; exit 2; }
exec 9>"$task_root/.deploy.lock"
flock -n 9 || { printf 'Another deployment or maintenance operation is running.\n' >&2; exit 1; }
# Credentials must be restored securely by the operator before invoking this
# script. Do not overwrite them blindly: PostgreSQL retains its existing user.
if [[ -f $task_saved_env ]]; then
  [[ ! -L $task_saved_env ]] || { printf 'The paired environment snapshot must be a regular file.\n' >&2; exit 2; }
  for task_key in API_KEY_ENCRYPTION_KEY POSTGRES_PASSWORD; do
    task_current=$(sed -n "s/^$task_key=//p" "$task_env")
    task_saved=$(sed -n "s/^$task_key=//p" "$task_saved_env")
    [[ -n $task_current && $task_current == "$task_saved" ]] || { printf 'The protected environment does not match the paired backup. Restore its matching encryption key/database credentials securely before proceeding.\n' >&2; exit 2; }
  done
else printf 'Legacy dump has no environment snapshot; ensure its original encryption key and database credentials are available.\n' >&2; fi
task_release=''
if [[ -f $task_root/.release.env ]]; then
  task_release_id=$(sed -n 's/^RELEASE_ID=//p' "$task_root/.release.env")
  [[ $task_release_id =~ ^[a-f0-9]{40}$ ]] || { printf 'Invalid current release metadata.\n' >&2; exit 2; }
  task_release=$task_root/releases/$task_release_id
  [[ -f $task_release/compose.deploy.yml && -f $task_release/.release.env ]] || { printf 'Current release bundle is missing.\n' >&2; exit 2; }
fi
compose() {
  if [[ -n $task_release ]]; then
    docker compose --project-name wisdom-tree --project-directory "$task_release" --env-file "$task_env" --env-file "$task_release/.release.env" -f "$task_release/compose.deploy.yml" "$@"
  else docker compose --project-directory "$task_root" --env-file "$task_env" -f "$task_root/compose.yml" "$@"; fi
}
task_container=$(compose ps --all --quiet api)
[[ $task_container =~ ^[a-f0-9]{12,64}$ ]] || { printf 'An existing API container is required to identify its upload volume.\n' >&2; exit 2; }
task_image=${SITE_ASSETS_TOOL_IMAGE:-$(docker inspect --format '{{.Image}}' "$task_container")}
[[ $task_image =~ ^sha256:[a-f0-9]{64}$ || $task_image =~ ^ghcr\.io/[a-z0-9][a-z0-9/_.-]*(@sha256:[a-f0-9]{64}|:[a-f0-9]{40})$ ]] || { printf 'Supply an immutable API tool image.\n' >&2; exit 2; }
task_project=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$task_container")
[[ $task_project =~ ^[a-z0-9][a-z0-9_-]*$ ]] || { printf 'Invalid Compose project name.\n' >&2; exit 2; }
task_volume=${task_project}_site_uploads
task_was_running=$(docker inspect --format '{{.State.Running}}' "$task_container")
task_db_url=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$task_container" | sed -n 's/^DATABASE_URL=//p')
[[ -n $task_db_url ]] || { printf 'The existing API database connection is missing.\n' >&2; exit 2; }
docker network inspect "${task_project}_internal" >/dev/null
# Full validation is read-only and happens before stopping the established API.
compose exec -T db pg_restore --file=/dev/null < "$task_dump"
if [[ -e $task_uploads ]]; then
  [[ -s $task_uploads && ! -L $task_uploads ]] || { printf 'Invalid paired upload archive.\n' >&2; exit 2; }
  docker run --rm -i --network none --read-only --memory 512m --cpus 1 --user 1000:1000 --entrypoint node "$task_image" dist/site-media-archive.js validate < "$task_uploads"
else printf 'Legacy dump has no upload archive; existing images will be preserved and all restored image references checked.\n' >&2; fi
task_database_restored=0
task_references_checked=0
cleanup() {
  local status=$?
  if [[ $task_was_running == true && ( $task_database_restored -eq 0 || $task_references_checked -eq 1 ) ]]; then
    compose start api >/dev/null || true
  elif [[ $task_database_restored -eq 1 && $task_references_checked -eq 0 ]]; then
    printf 'API remains stopped: restore the matching images and verify database references before starting it.\n' >&2
  fi
  exit "$status"
}
trap cleanup EXIT
compose stop api
if [[ -e $task_uploads ]]; then
  # The API image owns this directory as uid 1000. Mounting at the identical
  # prepared path initializes a new empty volume with that ownership.
  docker run --rm -i --network none --read-only --memory 512m --cpus 1 --user 1000:1000 \
    --mount "type=volume,src=$task_volume,dst=/var/lib/wisdom-tree/uploads" \
    -e SITE_UPLOAD_DIR=/var/lib/wisdom-tree/uploads --entrypoint node "$task_image" dist/site-media-archive.js merge < "$task_uploads"
fi
compose exec -T db pg_restore -U wisdom -d wisdom --clean --if-exists --no-owner --single-transaction < "$task_dump"
task_database_restored=1
# Use the same internal network and database connection, plus an explicit mount
# for legacy Compose releases. The tool image override works for old API images.
DATABASE_URL=$task_db_url
export DATABASE_URL
if docker volume inspect "$task_volume" >/dev/null 2>&1; then
  docker run --rm --network "${task_project}_internal" --read-only --memory 512m --cpus 1 --user 1000:1000 \
    --mount "type=volume,src=$task_volume,dst=/var/lib/wisdom-tree/uploads,readonly" \
    -e DATABASE_URL -e DATABASE_MODE=postgres -e SITE_UPLOAD_DIR=/var/lib/wisdom-tree/uploads \
    --entrypoint node "$task_image" dist/site-media-archive.js check-references
else
  docker run --rm --network "${task_project}_internal" --read-only --memory 512m --cpus 1 --user 1000:1000 \
    -e DATABASE_URL -e DATABASE_MODE=postgres -e SITE_UPLOAD_DIR=/var/lib/wisdom-tree/uploads \
    --entrypoint node "$task_image" dist/site-media-archive.js check-references
fi
unset DATABASE_URL task_db_url
task_references_checked=1
printf 'Database restored; immutable images preserved and references verified.\n'
