# Bullpen Healthcheck Automation

Cred-X now exposes:

- `GET /api/bullpen-ai/health`
- `GET /api/bullpen-ai/positions`
- `scripts/bullpen-healthcheck.ts`

The healthcheck script reads the live Bullpen wallet snapshot, retries Bullpen redeem/claim whenever resolved positions are still claimable, writes a JSON health report, and optionally posts the report to `BULLPEN_HEALTH_WEBHOOK_URL`.

## Required env

Configure these in both `/etc/investor/backend.env` and `/etc/investor/frontend.env`
on the server so the backend worker and frontend health checks read the same Bullpen
credential store:

```env
BULLPEN_BIN=/usr/local/bin/bullpen
BULLPEN_HOME=/var/lib/credx/bullpen
BULLPEN_CREDENTIALS_HOME=/var/lib/credx/bullpen
BULLPEN_HEALTH_STATE_DIR=/var/lib/credx/bullpen-health
BULLPEN_HEALTH_WEBHOOK_URL=
BULLPEN_AUTO_CLAIM_RESOLVED=true
BULLPEN_AUTO_CLAIM_RETRY_COOLDOWN_MS=60000
```

`BULLPEN_HOME` / `BULLPEN_CREDENTIALS_HOME` should point at the same credential HOME
used for the Bullpen login on the server. If the backend worker reads a different
`HOME`, Cred-X can still show `Session expired` even when a manual Bullpen login
looked successful in another shell context.

## Manual run

Run the healthcheck from the repo root:

```bash
node scripts/bullpen-healthcheck.ts
```

The script writes:

- `${BULLPEN_HEALTH_STATE_DIR}/bullpen-health.json`
- `${BULLPEN_HEALTH_STATE_DIR}/last-successful-live-snapshot.json`
- `${BULLPEN_HEALTH_STATE_DIR}/bullpen-auto-claim.json`

If the live CLI check fails, or if an automatic redeem/claim attempt fails, the script exits non-zero so `systemd`, `cron`, or external monitoring can alert.

## systemd every 5 minutes

Create `/etc/systemd/system/credx-bullpen-healthcheck.service`:

```ini
[Unit]
Description=Cred-X Bullpen live wallet healthcheck
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=/srv/investment-engine
EnvironmentFile=/srv/investment-engine/deploy/no-docker/frontend.env
ExecStart=/usr/bin/node /srv/investment-engine/scripts/bullpen-healthcheck.ts
User=investment-engine
Group=investment-engine
```

Create `/etc/systemd/system/credx-bullpen-healthcheck.timer`:

```ini
[Unit]
Description=Run Cred-X Bullpen healthcheck every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
Unit=credx-bullpen-healthcheck.service

[Install]
WantedBy=timers.target
```

Enable it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now credx-bullpen-healthcheck.timer
sudo systemctl status credx-bullpen-healthcheck.timer
```

Inspect recent runs:

```bash
journalctl -u credx-bullpen-healthcheck.service -n 50 --no-pager
```

## cron every 5 minutes

If you prefer cron, add:

```cron
*/5 * * * * cd /srv/investment-engine && set -a && . /srv/investment-engine/deploy/no-docker/frontend.env && set +a && /usr/bin/node scripts/bullpen-healthcheck.ts >> /var/log/credx-bullpen-healthcheck.log 2>&1
```

## Operator action

The health endpoint and Bullpen popup will classify failures as:

- `AUTH_EXPIRED`
- `NETWORK_ERROR`
- `BINARY_MISSING`
- `JSON_PARSE_ERROR`
- `TIMEOUT`
- `UNKNOWN_ERROR`

If the UI shows `AUTH_EXPIRED`, re-login on the server using the configured `HOME`:

```bash
sudo -u investor env HOME=/var/lib/credx/bullpen bullpen login
sudo -u investor env HOME=/var/lib/credx/bullpen bullpen polymarket positions --output json
sudo systemctl restart investor-backend investor-celery-worker
```

Do not trade or auto-claim based on tracked fallback data or a stale cached live snapshot.
