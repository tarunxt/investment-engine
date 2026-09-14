#!/usr/bin/env bash
set -euo pipefail

# PostgreSQL handles loss of a child by terminating peers and replaying WAL.
# systemd's default OOMPolicy=stop races that recovery with a smart shutdown,
# leaving the cluster refusing connections for up to TimeoutStopSec (one hour).
command -v pg_lsclusters >/dev/null 2>&1 || exit 0
while read -r pg_version pg_cluster pg_port _rest; do
  [[ "$pg_version" =~ ^[0-9]+$ && "$pg_cluster" =~ ^[a-zA-Z0-9_-]+$ ]] || continue
  [[ "$pg_port" == 5432 ]] || continue
  pg_unit="postgresql@${pg_version}-${pg_cluster}.service"
  dropin="/etc/systemd/system/${pg_unit}.d/credx-recovery.conf"
  sudo install -d -m 0755 "$(dirname "$dropin")"
  printf '%s\n' '[Service]' 'OOMPolicy=continue' 'Restart=on-failure' 'RestartSec=5s' 'KillSignal=SIGINT' |
    sudo tee "$dropin" >/dev/null
  sudo systemctl daemon-reload
  if pg_isready -h 127.0.0.1 -p "$pg_port" >/dev/null 2>&1; then
    continue
  fi
  pg_result="$(sudo systemctl show "$pg_unit" -p Result --value)"
  pg_state="$(sudo systemctl show "$pg_unit" -p ActiveState --value)"
  # Recover only the diagnosed OOM shutdown, never an intentional maintenance stop.
  if [[ "$pg_result" == oom-kill && "$pg_state" == deactivating ]]; then
    pg_data="/var/lib/postgresql/${pg_version}/${pg_cluster}"
    pg_ctl="/usr/lib/postgresql/${pg_version}/bin/pg_ctl"
    echo "Recovering PostgreSQL OOM shutdown: $pg_unit"
    if ! sudo -u postgres "$pg_ctl" -D "$pg_data" -m fast -w -t 30 stop; then
      echo 'Fast shutdown stalled; native immediate shutdown will replay WAL on restart.'
      sudo -u postgres "$pg_ctl" -D "$pg_data" -m immediate -w -t 20 stop
    fi
    sudo systemctl reset-failed "$pg_unit"
    timeout 45 sudo systemctl start "$pg_unit"
  elif [[ "$pg_result" == oom-kill && "$pg_state" == failed ]]; then
    sudo systemctl reset-failed "$pg_unit"
    timeout 45 sudo systemctl start "$pg_unit"
  fi
  pg_isready -h 127.0.0.1 -p "$pg_port"
done < <(pg_lsclusters --no-header)
