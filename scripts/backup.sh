#!/bin/sh
set -eu
task_backup_dir="${1:-backups}"
mkdir -p "$task_backup_dir"
task_backup_path="$task_backup_dir/wisdom-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose exec -T db pg_dump -U wisdom -d wisdom -Fc > "$task_backup_path"
test -s "$task_backup_path"
printf 'Backup saved: %s\n' "$task_backup_path"
