#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
task_root=${WISDOM_TREE_DIR:-/opt/wisdom-tree}
[[ $task_root == /* && $task_root != / ]] || { printf 'Invalid application directory.\n' >&2; exit 2; }
[[ -f $task_root/.previous-release.env ]] || { printf 'There is no previous successful release.\n' >&2; exit 1; }
task_previous=$(sed -n 's/^RELEASE_ID=//p' "$task_root/.previous-release.env")
[[ $task_previous =~ ^[a-f0-9]{40}$ ]] || { printf 'Invalid previous release metadata.\n' >&2; exit 1; }
task_previous_dir=$task_root/releases/$task_previous
cmp -s "$task_root/.previous-release.env" "$task_previous_dir/.release.env" || { printf 'Previous release bundle is missing or differs from its saved metadata.\n' >&2; exit 1; }
printf 'Restoring previous PostgreSQL 17 and application images. Database contents and schema are retained.\n'
task_script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# Use this release's current deployment safeguards with the previous metadata.
# Previous immutable bundles keep their original scripts and are never rewritten.
exec bash "$task_script_dir/deploy.sh" "$task_previous_dir/.release.env" --code-rollback
