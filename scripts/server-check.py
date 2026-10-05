"""Read-only SSH preflight. Password comes exclusively from the runner environment."""
import io
import json
import os
import socket
import sys
import paramiko

host = os.environ['DEPLOY_HOST']
port = int(os.environ.get('DEPLOY_PORT', '22'))
user = os.environ.get('DEPLOY_USER', 'root')
password = os.environ.get('DEPLOY_BOOTSTRAP_PASSWORD', '')
private_key = os.environ.get('DEPLOY_SSH_PRIVATE_KEY', '')
if not password and not private_key:
    sys.exit('Missing deployment SSH key or temporary bootstrap password.')
client = paramiko.SSHClient()
pinned = os.environ.get('DEPLOY_KNOWN_HOSTS', '').strip()
if pinned:
    for line in pinned.splitlines():
        entry = paramiko.hostkeys.HostKeyEntry.from_line(line)
        if entry:
            for name in entry.hostnames:
                client.get_host_keys().add(name, entry.key.get_name(), entry.key)
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
else:
    if private_key and not password:
        sys.exit('Key-based preflight requires the pinned DEPLOY_KNOWN_HOSTS secret.')
    # First-use discovery only; continuous deployment requires the returned pinned key.
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
try:
    pkey = paramiko.Ed25519Key.from_private_key(io.StringIO(private_key)) if private_key else None
    client.connect(host, port=port, username=user, password=password or None, pkey=pkey, timeout=15,
                   banner_timeout=20, auth_timeout=15, allow_agent=False, look_for_keys=False)
    key = client.get_transport().get_remote_server_key()
    known_name = host if port == 22 else f'[{host}]:{port}'
    result = {'host': host, 'port': port, 'user': user,
              'knownHosts': f'{known_name} {key.get_name()} {key.get_base64()}', 'checks': {}}
    for name, command in {
        'identity': 'id -u; uname -m; cat /etc/os-release',
        'capacity': 'free -m; df -h / /opt',
        'services': 'command -v docker || true; docker --version 2>/dev/null || true; docker compose version 2>/dev/null || true; ss -lntup',
        'containers': "docker ps --format '{{.Names}} {{.Image}} {{.Ports}}' 2>/dev/null || true",
        'workspace': 'ls -ld /opt /opt/wisdom-tree /srv/wisdom-tree 2>/dev/null || true',
    }.items():
        stdin, stdout, stderr = client.exec_command(command, timeout=30)
        output = stdout.read().decode('utf8', errors='replace').strip()
        status = stdout.channel.recv_exit_status()
        result['checks'][name] = {'status': status, 'output': output}
        print(f'[{name}]\n{output}')
    with open('server-preflight.json', 'w', encoding='utf8') as file:
        json.dump(result, file, ensure_ascii=False, indent=2)
    print('Read-only preflight complete; public host key recorded in the artifact.')
except (paramiko.SSHException, socket.error) as error:
    print(f'SSH preflight failed before deployment: {type(error).__name__}: {error}', file=sys.stderr)
    sys.exit(1)
finally:
    client.close()
