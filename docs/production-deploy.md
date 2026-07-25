# Production deploy runbook

This repo deploys production through GitHub Actions over SSH. Codex should change code in GitHub; GitHub Actions then syncs `main` to the EC2 checkout and restarts the production services.

## Production target

- Domain: `https://cred-x.in`
- EC2 app root: `/srv/investor`
- App user: `investor`
- Backend: FastAPI on `127.0.0.1:8000`
- Frontend: Next.js on `127.0.0.1:3000`
- Services restarted by deploy:
  - `investor-backend`
  - `investor-celery-worker` — `ai,email` (including Stage 3 execution and reconciliation)
  - `investor-celery-auto-live-worker` — dedicated `auto_live` planning queue
  - `investor-celery-beat`
  - `investor-celery-beat-worker` — `beat` periodic-dispatch queue
  - `investor-frontend` for full-stack deploys

## Required GitHub repository secrets

Set these under GitHub repo settings → Secrets and variables → Actions → Repository secrets:

- `EC2_HOST`: production EC2 public IP or hostname
- `EC2_USER`: SSH user, normally `ubuntu`
- `EC2_SSH_KEY`: private SSH key with access to the EC2 host

Do not commit the SSH key to the repo.

## Optional GitHub repository variables

The deploy workflow now defaults to the current production layout, so `APP_PATH` is not required.

Set these only if the server layout changes:

- `EC2_APP_PATH`: defaults to `/srv/investor`
- `EC2_APP_USER`: defaults to `investor`

## How deploy works

The workflow `.github/workflows/deploy.yml` runs on every push to `main` and can also be run manually.

On EC2 it does the following:

1. Verifies the app checkout exists.
2. Syncs the server repo to `origin/main` using the app user.
3. Runs `deploy/no-docker/redeploy.sh`.
4. Restarts the relevant systemd services.
5. Runs local smoke checks:
   - `http://127.0.0.1:8000/health/live`
   - `http://127.0.0.1:8000/health/ready`
   - `http://127.0.0.1:3000/login` for full-stack deploys

## Celery topology and Auto-Live recovery

Production deliberately isolates Auto-Live planning from long-lived Stage 3
remote-order reconciliation:

| Queue | Consumer | Work |
| --- | --- | --- |
| `auto_live` | `investor-celery-auto-live-worker` | `execute_polymarket_auto_live_run` (Stage 1/2 planning and the run handoff) |
| `ai,email` | `investor-celery-worker` | Stage 3 intent execution/reconciliation, audit-refresh work, and ordinary AI/email work |
| `beat` | `investor-celery-beat-worker` | periodic Auto-Live dispatch, reconciliation, watchdog, and outbox tasks |

Keep `CELERY_WORKER_QUEUES=ai,email` and
`CELERY_WORKER_PREFETCH_MULTIPLIER=1` in `/etc/investor/backend.env`; the
dedicated planning worker also defaults to concurrency `1` and prefetch `1`.
Do not merge `auto_live` back into `ai` (or leave `beat` on the primary worker)
to increase throughput: that would allow slow remote-order reconciliation or
periodic work to reserve planning capacity again.

The canonical primary launcher defaults to concurrency `2`, replaces a child
after 25 tasks or after it retains 800,000 KiB, and the planning worker replaces
its only child after every completed run. Bullpen runtime calls are serialized
by the shared runtime broker, so extra primary prefork children do not increase
remote-order throughput; they only retain duplicate Python/response memory and
hold extra database connections while waiting for the runtime lock. The deploy
removes the obsolete
`/etc/systemd/system/investor-celery-worker.service.d/no-beat-queue.conf`
drop-in and refuses to continue if any remaining override bypasses
`deploy/no-docker/scripts/run-celery-worker.sh`.

The run record exposes a durable task lifecycle: `QUEUED` means waiting for the
Auto-Live worker, `RESERVED` means received but waiting for a pool slot, and
`STARTED` has a worker heartbeat. Recovery never treats an ambiguous Celery
`PENDING` result, a partial inspect response, or an unchanged workflow timestamp
as proof that a queued/reserved task died. A started task is only marked
worker-lost after heartbeat expiry, the configured grace period, complete negative
worker evidence, and no redelivery; the two-hour workflow circuit breaker remains
the absolute limit. Deploy startup recovery is delayed so late-acknowledged work
has an opportunity to redeliver before any destructive action.

Redis remains the fast queue and lease store, but production Redis must use
`maxmemory-policy noeviction`: an evicted lease should never be normal operating
behavior. PostgreSQL session advisory fences backstop both a planning run and a
Stage 3 intent while remote work is in flight, so an unexpected Redis eviction
cannot admit concurrent work. Confirm the Redis policy before enabling live work:

```bash
sudo -u investor -H bash -lc '
  set -a; source /etc/investor/backend.env; set +a
  redis-cli -u "$REDIS_URL" CONFIG GET maxmemory-policy
'
```

If it is not `noeviction`, set `maxmemory-policy noeviction` in the host Redis
configuration, restart Redis during a planned maintenance window, and verify the
command again. Do not use an LRU/LFU/TTL eviction policy for this deployment.

After a deploy that adds this topology, verify all four backend task services:

```bash
sudo systemctl status \
  investor-celery-worker \
  investor-celery-auto-live-worker \
  investor-celery-beat \
  investor-celery-beat-worker --no-pager
sudo journalctl -u investor-celery-auto-live-worker -n 100 --no-pager
```

On older hosts, the deploy script resolves the equivalent
`investment-engine-*` service names. Do not manually stop or purge an
`auto_live` queue during a rolling restart: the run execution lease and
late-acknowledgement/redelivery handling are what preserve exactly-once planning.

### Auto-Live queue and lease verification

Run these from the production host after sourcing `/etc/investor/backend.env`.
They are read-only diagnostics; replace `RUN_ID` and `INTENT_ID` with the
values under investigation.

```bash
sudo -u investor -H bash -lc '
  cd /srv/investor/backend
  set -a; source /etc/investor/backend.env; set +a
  .venv/bin/celery -A app.infrastructure.messaging.celery_app inspect active_queues
  .venv/bin/celery -A app.infrastructure.messaging.celery_app inspect active
  .venv/bin/celery -A app.infrastructure.messaging.celery_app inspect reserved
  .venv/bin/celery -A app.infrastructure.messaging.celery_app inspect scheduled
'
```

```bash
sudo -u investor -H bash -lc '
  set -a; source /etc/investor/backend.env; set +a
  for queue in ai auto_live beat email; do
    printf "%s=" "$queue"
    redis-cli -u "$CELERY_BROKER_URL" LLEN "$queue"
  done
'
```

```bash
sudo -u investor -H env RUN_ID='replace-run-id' bash -lc '
  cd /srv/investor/backend
  set -a; source /etc/investor/backend.env; set +a
  .venv/bin/python - <<"PY"
import os
from app.domains.polymarket_auto_live.repository import SyncPolymarketAutoLiveRepository
from app.domains.polymarket_auto_live.run_lifecycle import (
    get_auto_live_run_execution_lease_sync,
)
from app.domains.polymarket_auto_live.advisory_lock import (
    auto_live_run_execution_advisory_lock_is_live_sync,
)
from app.infrastructure.database.sync_session import SyncSessionLocal

run_id = os.environ["RUN_ID"]
with SyncSessionLocal() as session:
    run = SyncPolymarketAutoLiveRepository(session).get_run(run_id)
print(run.task_lifecycle.model_dump(mode="json") if run and run.task_lifecycle else None)
print(get_auto_live_run_execution_lease_sync(run_id))
print({"run_advisory_fence_live": auto_live_run_execution_advisory_lock_is_live_sync(run_id)})
PY
'
```

```bash
sudo -u investor -H env INTENT_ID='replace-intent-id' RUN_ID='replace-run-id' bash -lc '
  cd /srv/investor/backend
  set -a; source /etc/investor/backend.env; set +a
  .venv/bin/python - <<"PY"
import os
from app.domains.polymarket_auto_live.order_intent_lease import (
    get_order_intent_operation_lease_sync,
)
from app.domains.bullpen_run_audit.tasks import _audit_refresh_key, _audit_refresh_redis_client

intent_id = os.environ["INTENT_ID"]
run_id = os.environ["RUN_ID"]
print(get_order_intent_operation_lease_sync(intent_id))
client = _audit_refresh_redis_client()
try:
    print({
        "audit_refresh_pending": client.get(_audit_refresh_key("pending", run_id)),
        "audit_refresh_lease": client.get(_audit_refresh_key("lease", run_id)),
    })
finally:
    client.close()
PY
'
```

To spot a duplicate broker fan-out, inspect `active`, `reserved`, and
`scheduled` above and ensure each
`reconcile_auto_live_order_intent` appears at most once per intent ID. The
worker logs should remain free of the former materialization collision:

```bash
sudo journalctl -u investor-celery-worker --since '1 hour ago' --no-pager \
  | rg 'duplicate key.*snapshot_id.*event_key|Stage 3 order-intent audit refresh failed'
```

## Manual deploy

From GitHub Actions, run **Deploy to Production** manually:

- `backend`: backend-only deploy
- `full`: backend + frontend deploy
- `auto`: full deploy when run manually

## Important rule

Do not manually edit production files on EC2 as the normal path. Those edits can be overwritten by the next deploy. Make the change in GitHub, merge/push to `main`, and let the deploy workflow update EC2.
