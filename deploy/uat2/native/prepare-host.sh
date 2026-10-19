#!/usr/bin/env bash
# SECURITY-SENSITIVE FUTURE HOST SETUP. Do not run before its exact action-time approval.
# No package installation or cloud provisioning is performed by this script.
set -euo pipefail
umask 077
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHONPATH="$HERE" python3 -c 'from ctl import host_guard; host_guard()'
for program in /usr/sbin/nft /usr/bin/python3 /usr/bin/node /usr/bin/redis-server /usr/bin/caddy /usr/sbin/nginx /usr/lib/postgresql/16/bin/initdb; do
  test -x "$program" || { echo "Required supported host package missing: $program" >&2; exit 1; }
done
python3 -c 'import sys; assert sys.version_info[:2] == (3,12)'
/usr/bin/node -e 'if(process.versions.node.split(".")[0]!=="22")process.exit(1)'
for account in credx-uat2-app credx-uat2-web credx-uat2-db credx-uat2-redis credx-uat2-certs credx-uat2-proxy; do
  id "$account" >/dev/null 2>&1 || useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$account"
done
install -d -m 0755 /opt/credx-uat2/releases /var/lib/credx-uat2 /etc/credx-uat2
install -d -m 0700 -o credx-uat2-db -g credx-uat2-db /var/lib/credx-uat2/postgres
install -d -m 0700 -o credx-uat2-redis -g credx-uat2-redis /var/lib/credx-uat2/redis
install -d -m 0700 -o credx-uat2-proxy -g credx-uat2-proxy /var/lib/credx-uat2/proxy
install -d -m 0750 -o credx-uat2-app -g credx-uat2-app /var/lib/credx-uat2/artifacts
install -d -m 0750 -o credx-uat2-web -g credx-uat2-web /var/cache/credx-uat2-next
for file in postgresql.conf pg_hba.conf redis.conf Caddyfile nginx.conf; do
  install -m 0644 "$HERE/$file" "/etc/credx-uat2/$file"
done
if [[ ! -f /var/lib/credx-uat2/postgres/PG_VERSION ]]; then
  runuser -u credx-uat2-db -- /usr/lib/postgresql/16/bin/initdb -D /var/lib/credx-uat2/postgres --auth-local=peer --auth-host=scram-sha-256 --no-instructions
else
  [[ "$(cat /var/lib/credx-uat2/postgres/PG_VERSION)" == 16 ]] || { echo 'Unexpected UAT2 PostgreSQL version' >&2; exit 1; }
fi
echo 'Dedicated native host layout prepared. No application started; provision approved independent runtime configuration using mandated tooling.'
