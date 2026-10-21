# Stage 15 local guarded execution and reconciliation

Canonical title: **Implement guarded execution and order reconciliation**, [full specification](stages/15.md). Local implementation began 21 October 2026 at 10:19:34 UTC on `codex/stage15-guarded-execution-local-20261021`, isolated in `stage15-guarded-execution`, based on accepted `802790f675169bf446d1083f6d542b79d272d6a7`. The external handoff pins the final candidate, actual test counts and source hashes.

## Prerequisite reconciliation

Stage 14's earlier local/failed-CI checkpoints are historical, not current holds. Final 802 passed 48 checks, eight PostgreSQL cases, twenty Linux cases and independent artifact/source/offline verification. Saved deployment receipts record maintenance 09:45:38–09:46:09 UTC, schema `order_intents_001`, fresh private Stage 13 backup `uat2-20261021T094548830380Z.dump`, healthy services, owner isolation and disabled runtime. The parent independently verified the installed release and the owner accepted the deployed inactive scope at 10:04:37 UTC, with browser/storage limitations explicitly retained. This does not mean automated browser acceptance ran, missing browser/summary files were saved, or production is healthy now. No live checks were repeated in this task. PR1240's recorded `ddefd7306003dc8e4e662d3b88abe167da77f036` and the preserved Google login `0c6e61e524c7a87c7b9ea79342f17b14a45e97a1` are ancestors of the accepted source; no merge/reset was performed.

## Requirement map and implementation

| Requirement | Reuse and new implementation | Evidence / remaining gate |
|---|---|---|
| Explicit approved intent | Existing `Orders`, immutable request/review/approval digests, authenticated confirmation capability, intent/leg models and transactional outbox | Stage14 suites retained; no worker can mint confirmation |
| Controlled durable worker | `execution.py` adds one persisted run per intent and one attempt per leg, committed before the fake effect; approval/outbox/request/leg binding is rechecked | Duplicate delivery, crash and fresh-boundary tests; actual PG races prepared |
| Current risk | Existing owner/module/capability/connection fences and frozen risk evidence plus `execution_risk.py` exact-decimal fresh checks | Account/mode/version, expiry, quotes, source, product, lots/ticks/circuits, protected limit price, holdings, funds, notional/exposure/rate tests |
| No advisory fallback | Exact `MarketDataFake` composition only, with account-bound authoritative fake observations; request fallback prices are not accepted | Untrusted-source, stale/future and precision negatives |
| Unknown outcomes | A committed claim is never submitted again, including proven missing matches; timeout stays unknown | Persistent separate fake venue survives app-session restart; no exactly-once claim |
| Reconciliation | At most five persisted poll reservations over ten minutes, exponential delay capped at 30 seconds; exact single match and bound unique trades must quantitatively corroborate fills | Missing/ambiguous/read failure/duplicate trade and invalid receipt tests; actual PG parallel reservation prepared |
| Basket dependencies | Later legs require quantitative filled evidence; every effect consumes its balance observation, and subsequent work needs a newer observation | Sell receipt alone cannot create funds; changed payload/risk/limits requires new review; no implicit submission from reconciliation |
| Stops and disconnect | Durable platform/owner/connection stop fences block new effects; original-account read-only reconciliation survives disable/disconnect/expiry | Stop and module/account races prepared; disconnect never liquidates |
| Serialization | Shared stop locks and exclusive owner/account execution fence; existing canonical owner/selection/connection/intent locks | SQLite is not PostgreSQL certification; actual PG gate remains unrun locally |
| Migration/recovery | Additive `order_execution_001` follows `order_intents_001`; populated unguarded downgrade refuses; existing native controller/helper extended for exact Stage14 backup and Stage15 rollback | Full private preservation, transactional cleanup/DDL, strict fingerprints, markers and verification-only recovery retained; twenty actual Linux cases prepared |
| Legacy routes | Existing direct financial/legacy/recovery write denials unchanged | Stage14 HTTP/legacy negative suites; no live transport or provider calls |

Supported synthetic payloads remain the Stage14 exact LIMIT/CNC NSE/BSE cash-equity subset. Unsupported order/product/market modes fail closed. This is preparation for later reviewed composition, not evidence of real-market correctness, brokerage matching support, provider registration or approval. Quotes/funds/holdings are synthetic fixtures only. Current production tick/circuit/financial gates and protected-market routes remain denied; no unsupported mode was silently substituted.

## Runtime boundary

There is no new normal-runtime Celery registration, scheduler, financial outbox consumer, HTTP activation endpoint, credential resolver, or real broker adapter. `ExecutionWorker` accepts the exact fake adapter with a separate disposable SQLite venue. `MarketDataFake` cannot be replaced by a real provider through configuration. Existing `/order-intents/status` remains inactive; preparation/confirmation runtime dependency still denies. An export, notification, trade or production action is never part of this preview.

The synthetic stop-control method is a trusted harness composition method, not an authenticated operator API or a new access grant. A later activation design must separately establish provider matching semantics, bounded transport deadlines, actual pricing/market policies and operator authorization. Financial orders remain separately confirmed; no standing consent or unattended execution is added.

## Local walkthrough and stop

From this worktree:

```sh
PYTHONPATH=backend ../stage09-recovery-successor/.runtime/python/bin/python backend/scripts/stage15_synthetic_preview.py
```

The script refuses dotenv files and clears inherited environment before imports. It creates private disposable application and fake-venue SQLite databases, prepares an exact synthetic order/review, simulates an explicit authenticated confirmation, loses a response after fake acceptance, restarts the application session and reconciles to a quantitatively supported fill under a platform stop. It asserts one fake submission and zero submissions after restart. It starts no listener or service. Exit stops it; Ctrl-C stops an interrupted foreground run. Databases are removed on exit. This backend walkthrough is not a substitute frontend or live browser acceptance. No frontend source changed.

## Verification and release limits

Local Stage15 tests: 91 passed, including two actual owned subprocess exits with no exception cleanup. Broader Stage12–15 backend regression: 489 passed (overlaps the 91), native controller/recovery: 177 passed, safe runner harness: eight passed with two inherited listener cases not retried, source inventory: five passed and unresolved list empty. Docker CLI exists but its daemon socket is unavailable, so nine prepared PostgreSQL cases and twenty Linux/systemd cases remain unrun. Two inherited readiness listener tests are deliberately not retried locally after the earlier bind denial; their checks remain present for the future supported CI environment, not skipped from CI. Stage14 frozen checks remain at exact 802 beside the new current-head gates. New exact-head Stage15 jobs demand all 100 focused/PostgreSQL cases and zero skips, plus twenty Linux cases with positive 503 injection/failure/recovery evidence. JUnit evidence and the clean-candidate walkthrough are recorded in the external handoff.

Code/local checks, independent review, publication, CI/artifacts, UAT2 deployment/verification, owner acceptance and provider approval remain separate states. No push, PR, CI trigger, deployment, runtime activation, live provider call, real export/send/order, AWS/security/credential change, purchase or Stage16 is authorized here. Existing US$10 allowance is not a guaranteed cap; today's 21:04:13 IST manual stop and retention are unchanged. Current billing/production health were not checked or inferred from old receipts.

## Storage preparation

Only the two explicitly approved old Webpack caches were removed: Stage09 616,217,061 bytes and Stage11 691,025,468 bytes of generated files. No other cleanup occurred. Both removals were read back absent and a 1 MiB write/read/fsync probe passed and was removed. Availability at that check was 1,737,768,960 bytes; observed filesystem free-space gain was negative 114,688 bytes, so physical reclaimed space is not claimed. All source, compiled applications, original ZIPs, receipts and backups were preserved. The unrelated missing Stage14 saves were not retried.
