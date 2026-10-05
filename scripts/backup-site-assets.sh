#!/usr/bin/env bash
# Caller must stop all API writers before pairing this with a database dump.
set -Eeuo pipefail
umask 077
[[ $# -eq 3 ]] || { printf 'Usage: bash backup-site-assets.sh <immutable-api-image> <named-volume> <archive-output>\n' >&2; exit 2; }
task_image=$1
task_volume=$2
task_output=$3
[[ $task_image =~ ^sha256:[a-f0-9]{64}$ || $task_image =~ ^ghcr\.io/[a-z0-9][a-z0-9/_.-]*(@sha256:[a-f0-9]{64}|:[a-f0-9]{40})$ ]] || { printf 'Supply an immutable API image.\n' >&2; exit 2; }
[[ $task_volume =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]+$ ]] || { printf 'Invalid upload volume name.\n' >&2; exit 2; }
[[ ! -e $task_output && ! -L $task_output ]] || { printf 'Upload backup already exists.\n' >&2; exit 2; }
task_parent=$(dirname -- "$task_output")
[[ -d $task_parent ]] || { printf 'Backup output directory is missing.\n' >&2; exit 2; }
task_temporary=$(mktemp "$task_parent/.uploads.XXXXXXXX")
trap 'rm -f -- "$task_temporary"' EXIT
task_volumes=$(docker volume ls --format '{{.Name}}')
if printf '%s\n' "$task_volumes" | grep -Fxq -- "$task_volume"; then
  docker volume inspect "$task_volume" >/dev/null
  docker run --rm --network none --read-only --memory 512m --cpus 1 --user 1000:1000 \
    --mount "type=volume,src=$task_volume,dst=/var/lib/wisdom-tree/uploads,readonly" \
    --entrypoint tar "$task_image" -czf - -C /var/lib/wisdom-tree/uploads . > "$task_temporary"
else
  # --mount would create a missing named volume. A legacy release has no uploads:
  # produce a valid empty archive without touching any application volume.
  docker run --rm --network none --read-only --memory 512m --cpus 1 --user 1000:1000 \
    --entrypoint node "$task_image" dist/site-media-archive.js empty > "$task_temporary"
fi
[[ -s $task_temporary ]]
docker run --rm -i --network none --read-only --memory 512m --cpus 1 --user 1000:1000 \
  --entrypoint node "$task_image" dist/site-media-archive.js validate < "$task_temporary"
chmod 600 "$task_temporary"
# Atomic create-if-absent also protects against an output path created mid-backup.
ln -- "$task_temporary" "$task_output"
rm -f -- "$task_temporary"
trap - EXIT
printf 'Protected upload backup saved: %s\n' "$task_output"
