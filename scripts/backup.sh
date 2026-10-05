#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ $# -le 1 ]] || { printf 'Usage: bash scripts/backup.sh [backup-directory]\n' >&2; exit 2; }
task_root=$(pwd -P)
task_script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
task_env=$task_root/.env
[[ -f $task_env && ! -L $task_env ]] || { printf 'Run from the application directory containing its protected .env.\n' >&2; exit 2; }
exec 9>"$task_root/.deploy.lock"
flock -n 9 || { printf 'Another deployment or maintenance operation is running.\n' >&2; exit 1; }
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
[[ $task_container =~ ^[a-f0-9]{12,64}$ ]] || { printf 'An existing API container is required to identify its images and upload volume.\n' >&2; exit 2; }
task_image=${SITE_ASSETS_TOOL_IMAGE:-$(docker inspect --format '{{.Image}}' "$task_container")}
task_project=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$task_container")
[[ $task_project =~ ^[a-z0-9][a-z0-9_-]*$ ]] || { printf 'Invalid Compose project name.\n' >&2; exit 2; }
task_volume=${task_project}_site_uploads
task_was_running=$(docker inspect --format '{{.State.Running}}' "$task_container")
task_backup_dir=${1:-backups}
mkdir -p -- "$task_backup_dir"
chmod 700 "$task_backup_dir"
task_backup_id=wisdom-$(date -u +%Y%m%dT%H%M%SZ)-$$
task_dump=$task_backup_dir/$task_backup_id.dump
task_env_backup=$task_backup_dir/$task_backup_id.env
task_uploads=$task_backup_dir/$task_backup_id.uploads.tar.gz
[[ ! -e $task_dump && ! -e $task_env_backup && ! -e $task_uploads ]]
task_dump_tmp=$(mktemp "$task_backup_dir/.dump.XXXXXXXX")
task_env_tmp=$(mktemp "$task_backup_dir/.env.XXXXXXXX")
cleanup() {
  rm -f -- "$task_dump_tmp" "$task_env_tmp"
  if [[ $task_was_running == true ]]; then compose start api >/dev/null; fi
}
trap cleanup EXIT
compose stop api
compose exec -T db pg_dump -U wisdom -d wisdom -Fc > "$task_dump_tmp"
[[ -s $task_dump_tmp ]]
compose exec -T db pg_restore --file=/dev/null < "$task_dump_tmp"
bash "$task_script_dir/backup-site-assets.sh" "$task_image" "$task_volume" "$task_uploads"
cp -- "$task_env" "$task_env_tmp"
chmod 600 "$task_dump_tmp" "$task_env_tmp"
mv -- "$task_dump_tmp" "$task_dump"
mv -- "$task_env_tmp" "$task_env_backup"
printf 'Paired backup saved: %s (.dump, .env, .uploads.tar.gz)\n' "$task_backup_dir/$task_backup_id"
