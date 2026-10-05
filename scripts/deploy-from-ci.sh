#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ $# -eq 1 ]] || { printf 'Usage: deploy-from-ci.sh <release.env>\n' >&2; exit 2; }
IFS= read -r task_registry_user
IFS= read -r task_registry_token
[[ -n "$task_registry_user" && -n "$task_registry_token" ]] || exit 2
task_docker_config=$(mktemp -d)
export DOCKER_CONFIG="$task_docker_config"
trap 'rm -rf -- "$task_docker_config"' EXIT
printf '%s' "$task_registry_token" | docker login ghcr.io -u "$task_registry_user" --password-stdin >/dev/null
unset task_registry_token
task_script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
bash "$task_script_dir/deploy.sh" "$1"
