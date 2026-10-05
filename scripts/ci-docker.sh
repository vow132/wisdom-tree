#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ -n "${API_IMAGE:-}" && -n "${WEB_IMAGE:-}" ]] || exit 2
mkdir -p .local
{
  printf 'API_IMAGE=%s\nWEB_IMAGE=%s\n' "$API_IMAGE" "$WEB_IMAGE"
  if [[ -n "${DB_IMAGE:-}" ]]; then printf 'DB_IMAGE=%s\n' "$DB_IMAGE"; fi
  if [[ -n "${CADDY_IMAGE:-}" ]]; then printf 'CADDY_IMAGE=%s\n' "$CADDY_IMAGE"; fi
  printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 24)"
  printf 'API_KEY_ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)"
  printf 'ADMIN_USERNAME=ci_admin\nADMIN_PASSWORD=%s\n' "$(openssl rand -hex 16)"
  printf 'SITE_ADDRESS=http://127.0.0.1\nPUBLIC_ORIGIN=http://127.0.0.1\n'
} > .local/docker-ci.env
docker compose --project-name wisdom-ci --env-file .local/docker-ci.env -f compose.deploy.yml pull --quiet
docker compose --project-name wisdom-ci --env-file .local/docker-ci.env -f compose.deploy.yml up -d --wait --wait-timeout 180
docker compose --project-name wisdom-ci --env-file .local/docker-ci.env -f compose.deploy.yml exec -T api node dist/admin-cli.js
export CI_ADMIN_USERNAME=ci_admin
CI_ADMIN_PASSWORD=$(sed -n 's/^ADMIN_PASSWORD=//p' .local/docker-ci.env)
export CI_ADMIN_PASSWORD
node scripts/ci-docker-smoke.mjs
# Exercise the Alpine image decoder and paired media backup with real Docker.
bash scripts/backup-site-assets.sh "$API_IMAGE" wisdom-ci_site_uploads .local/docker-ci.uploads.tar.gz
task_restore_volume=wisdom-ci-media-restore
cleanup_media_probe() { docker volume rm "$task_restore_volume" >/dev/null 2>&1 || true; }
[[ -z $(docker volume ls --quiet --filter "name=^${task_restore_volume}$") ]] || { printf 'Disposable media restore volume already exists.\n' >&2; exit 1; }
trap cleanup_media_probe EXIT
docker run --rm -i --network none --read-only --memory 512m --cpus 1 --user 1000:1000 \
  --mount "type=volume,src=$task_restore_volume,dst=/var/lib/wisdom-tree/uploads" \
  --entrypoint node "$API_IMAGE" dist/site-media-archive.js merge < .local/docker-ci.uploads.tar.gz > .local/docker-ci-media-merge.json
node --input-type=module -e 'import fs from "node:fs"; import assert from "node:assert/strict"; const result=JSON.parse(fs.readFileSync(".local/docker-ci-media-merge.json")); assert.equal(result.files,3); assert.equal(result.added,3);'
docker run --rm -i --network none --read-only --memory 512m --cpus 1 --user 1000:1000 \
  --mount "type=volume,src=$task_restore_volume,dst=/var/lib/wisdom-tree/uploads" \
  --entrypoint node "$API_IMAGE" dist/site-media-archive.js merge < .local/docker-ci.uploads.tar.gz > .local/docker-ci-media-merge.json
node --input-type=module -e 'import fs from "node:fs"; import assert from "node:assert/strict"; const result=JSON.parse(fs.readFileSync(".local/docker-ci-media-merge.json")); assert.equal(result.files,3); assert.equal(result.added,0);'
docker compose --project-name wisdom-ci --env-file .local/docker-ci.env -f compose.deploy.yml up -d --force-recreate --wait --wait-timeout 120 api
node scripts/ci-docker-smoke.mjs --verify-assets-only
docker compose --project-name wisdom-ci --env-file .local/docker-ci.env -f compose.deploy.yml exec -T api node dist/site-media-archive.js check-references
printf 'Uploaded images survived container recreation; media backup and idempotent restore passed.\n'
