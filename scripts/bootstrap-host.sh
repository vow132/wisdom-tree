#!/usr/bin/env bash
# One-time Ubuntu/Debian provisioning; leaves an existing Docker install alone.
set -Eeuo pipefail
umask 077
[[ $EUID -eq 0 ]] || { printf 'Run bootstrap-host.sh as root.\n' >&2; exit 1; }
task_domain=${1:-ai.91i.asia}
task_root=${WISDOM_TREE_DIR:-/opt/wisdom-tree}
[[ $task_domain =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$ && $task_domain == *.* ]] || { printf 'Supply a domain without a scheme or path.\n' >&2; exit 2; }
[[ $task_root == /* && $task_root != / ]] || { printf 'Invalid application directory.\n' >&2; exit 2; }
[[ -r /etc/os-release ]] || { printf 'Unknown operating system.\n' >&2; exit 1; }
# OS-owned configuration, not a user-controlled release file.
source /etc/os-release
case "$ID" in ubuntu|debian) ;; *) printf 'Bootstrap supports Ubuntu and Debian only; preserve and configure this host manually.\n' >&2; exit 1 ;; esac
task_codename=${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}
[[ $task_codename =~ ^[a-z]+$ ]] || { printf 'Unable to determine the OS codename.\n' >&2; exit 1; }
command -v ss >/dev/null || { printf 'Install iproute2 and inspect HTTP/HTTPS listeners before provisioning.\n' >&2; exit 1; }
for task_port in 80 443; do
  if [[ -n $(ss -H -ltn "sport = :$task_port") ]]; then
    # Permit a repeat bootstrap only when our existing stack owns the port.
    if ! command -v docker >/dev/null || [[ -z $(docker ps --filter label=com.docker.compose.project=wisdom-tree --filter "publish=$task_port" --format '{{.ID}}') ]]; then
      printf 'TCP port %s is already occupied. Existing services were left unchanged.\n' "$task_port" >&2
      exit 1
    fi
  fi
done

task_need_tools=0
for task_tool in curl openssl flock; do
  command -v "$task_tool" >/dev/null || task_need_tools=1
done
if [[ $task_need_tools -eq 1 ]]; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl openssl util-linux
fi
if command -v docker >/dev/null; then
  docker info >/dev/null
  docker compose version >/dev/null || { printf 'Existing Docker has no Compose plugin; install a compatible plugin without replacing the engine.\n' >&2; exit 1; }
  printf 'Existing Docker and Compose were retained.\n'
else
  for task_package in docker.io podman-docker containerd runc; do
    if dpkg-query -W -f='${Status}' "$task_package" 2>/dev/null | grep -q 'install ok installed'; then
      printf 'Existing package %s may own other workloads. Docker installation was not attempted.\n' "$task_package" >&2
      exit 1
    fi
  done
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl openssl util-linux
  if ! grep -Rqs 'https://download.docker.com/linux/' /etc/apt/sources.list /etc/apt/sources.list.d; then
    install -d -m 0755 /etc/apt/keyrings
    curl --fail --silent --show-error --location "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/wisdom-tree-docker.asc
    chmod 0644 /etc/apt/keyrings/wisdom-tree-docker.asc
    task_arch=$(dpkg --print-architecture)
    cat >/etc/apt/sources.list.d/wisdom-tree-docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/$ID
Suites: $task_codename
Components: stable
Architectures: $task_arch
Signed-By: /etc/apt/keyrings/wisdom-tree-docker.asc
EOF
    chmod 0644 /etc/apt/sources.list.d/wisdom-tree-docker.sources
  fi
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
  docker info >/dev/null
  docker compose version >/dev/null
fi

mkdir -p "$task_root" "$task_root/incoming" "$task_root/releases" "$task_root/backups"
chmod 700 "$task_root" "$task_root/backups"
if [[ -e $task_root/.env ]]; then
  [[ -f $task_root/.env && ! -L $task_root/.env ]] || { printf 'The server .env must be a regular file.\n' >&2; exit 1; }
  chmod 600 "$task_root/.env"
  printf 'Existing server configuration and credentials were preserved.\n'
else
  task_env_tmp=$(mktemp "$task_root/.bootstrap-env.XXXXXXXX")
  trap 'rm -f -- "$task_env_tmp"' EXIT
  task_database_password=$(openssl rand -hex 24)
  task_admin_password=$(openssl rand -hex 24)
  task_encryption_key=$(openssl rand -hex 32)
  cat >"$task_env_tmp" <<EOF
SITE_ADDRESS=$task_domain
PUBLIC_ORIGIN=https://$task_domain
ACME_EMAIL=
POSTGRES_PASSWORD=$task_database_password
API_KEY_ENCRYPTION_KEY=$task_encryption_key
ADMIN_USERNAME=admin
ADMIN_PASSWORD=$task_admin_password
DB_POOL_MAX=5
LOG_LEVEL=info
EOF
  chmod 600 "$task_env_tmp"
  # Atomic create-if-absent: do not replace credentials on a repeated bootstrap.
  ln -- "$task_env_tmp" "$task_root/.env"
  rm -f -- "$task_env_tmp"
  trap - EXIT
  unset task_database_password task_admin_password task_encryption_key
  printf 'Server .env created with random credentials and permission 600. Credentials were not printed.\n'
fi
printf 'Host ready for an immutable image release at https://%s.\n' "$task_domain"
