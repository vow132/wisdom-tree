#!/bin/sh
set -eu
if [ "$#" -ne 2 ] || [ "$2" != "--replace-database" ]; then
  printf 'Usage: sh scripts/restore.sh <backup.dump> --replace-database\n' >&2
  exit 2
fi
test -s "$1"
docker compose stop api
trap 'docker compose start api >/dev/null' EXIT
docker compose exec -T db pg_restore -U wisdom -d wisdom --clean --if-exists --no-owner --single-transaction < "$1"
printf 'Database restored.\n'
