# Bullpen Passive Healthcheck

The production timer is a read-only observer of the centralized backend Bullpen
runtime. It reads the runtime broker's shared Redis health, authentication, and
positions-snapshot metadata and atomically writes a bounded report. It never:

- spawns the Bullpen CLI;
- runs an active doctor or refresh;
- logs in or owns a second authentication session;
- submits a trade, claim, redeem, approval, or any other external mutation;
- updates or deletes broker cache keys;
- writes raw positions, wallet identity, credential metadata, or secrets.

The frontend health and positions routes remain passive cache readers. The
authenticated `GET /polymarket/runtime/diagnostics` endpoint is reserved for an
explicit operator-triggered preflight; the timer does not call it.

## Configuration

Configure monitoring only in the canonical production backend environment file,
`/etc/investor/backend.env`:

```env
BULLPEN_HEALTH_STATE_DIR=/home/investor/.bullpen-health
BULLPEN_HEALTH_WEBHOOK_URL=
BULLPEN_HEALTH_WEBHOOK_TIMEOUT_SECONDS=10
```

`BULLPEN_HEALTH_STATE_DIR` must be an absolute, non-symlink directory. The
healthcheck creates the report with mode `0600` and replaces it atomically:

```text
${BULLPEN_HEALTH_STATE_DIR}/bullpen-health.json
```

The optional webhook receives that same sanitized report with a timeout clamped
to 1 through 30 seconds. The webhook URL is never included in the report or
printed to the journal.

The former frontend TypeScript health runner and its auto-claim behavior are
retired. `BULLPEN_AUTO_CLAIM_RESOLVED` and
`BULLPEN_AUTO_CLAIM_RETRY_COOLDOWN_MS` no longer control monitoring. Historical
`last-successful-live-snapshot.json` and `bullpen-auto-claim.json` files are not
read, updated, or deleted automatically. Claims and redeems belong only to the
durable Stage 3 execution path with its normal authorization and reconciliation
guards.

## Manual passive run

Load the canonical backend environment, then invoke the backend virtualenv
module:

```bash
cd /srv/investor/backend
set -a
. /etc/investor/backend.env
set +a
.venv/bin/python -m app.domains.polymarket.passive_healthcheck
```

The command exits zero only when the cached broker report is healthy and the
optional webhook, when configured, succeeds. Redis/cache read failures,
unhealthy shared authentication state, report-write failures, and webhook
delivery failures exit non-zero. None of these failure paths starts an active
Bullpen operation.

## systemd

Deployment renders and installs:

- `credx-bullpen-healthcheck.service`
- `credx-bullpen-healthcheck.timer`

The service runs the backend module as the application user with
`/etc/investor/backend.env`; the timer runs five minutes after boot and every
five minutes thereafter.

```bash
sudo systemctl status credx-bullpen-healthcheck.timer --no-pager
sudo systemctl start credx-bullpen-healthcheck.service
journalctl -u credx-bullpen-healthcheck.service -n 50 --no-pager
```

## Interpreting the report

The report contains:

- `ok`, `classification`, and a redacted bounded message;
- boolean and timestamp-only shared authentication status;
- timestamp, source, freshness, and classifier version for the cached positions
  snapshot;
- a bounded, redacted last-failure summary when one exists.

It deliberately omits the account identity, wallet address, credential
artifact, command path, effective home, raw snapshot payload, position rows, and
runtime diagnostics.

If shared authentication is unhealthy, perform the normal operator login and
active diagnostic workflow. Do not bypass doctor, wallet-route, balance,
market-state, or Stage 3 safety gates, and do not trade or claim from a stale
monitoring report.
