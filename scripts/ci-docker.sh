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
