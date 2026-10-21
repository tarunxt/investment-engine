# Current Stage14 risk/receipt correction

This document retains the original2c8cb43d candidate description and test history. The local successor fixes both independent P2 findings; [STAGE14_REVIEW_CORRECTION.md](STAGE14_REVIEW_CORRECTION.md) is the current correction and152focused/410combined result record. Required behavior is unchanged; risk evidence is mandatory and fill receipts must prove exact quantitative leg completion. Independent re-review,7PG/20Linux and external gates remain pending. No publication or activation.

# Stage14 local order intent preparation

Canonical title: **Implement durable order intents and explicit approvals**. Source: stages/14.md. Local work began at07:19:16UTC21October2026 (Git branch creation receipt), based on owner-accepted inactive Stage13 `31ecd3fa59a5e4ce4847170ff6b973a9e0709ddd`. Isolated branch `codex/stage14-order-approvals-local-20261021`; external candidate handoff pins the containing commit. Nothing is pushed or deployed. UAT2 remains accepted Stage13, owner-only and simulated, analysis runtime unregistered. Owner acceptance did not retroactively run the locked-Mac browser check.

## Implemented contract

`order_intents` reuses existing User identity, UserModulePreferences/ModulePolicy version fences, IntegrationConnection account/mode/version and binding history, canonical_digest and transactional OutboxMessage. Financial intent uniqueness is deliberately separate from job-only IdempotencyOperation: its existing job foreign key cannot represent financial intents. It uses the required durable unique(owner, operation-key-digest), not Redis or a parallel tenant/ownership registry.

Create records an immutable normalized basket and each leg before I/O. The initial supported synthetic subset is exact LIMIT/CNC NSE/BSE cash-equity orders with integer quantities, positive decimal prices up to two decimal places, explicit listed or sell-before-buy sequencing and bounded basket size. Unsupported order types, duplicate instruments, ambiguous prices, unknown fields and automatic substitutions fail closed. No algorithm clamps quantity or silently changes market/AMO mode. A material edit requires a new intent/review; reuse of an operation key with a different request is rejected.

Transitions are draft → validated → awaiting_approval → approved → submitting → acknowledged/unknown/partial/filled/rejected. Revocation before dispatch records cancelled; submitted or uncertain work requires reconciliation and cannot be blindly cancelled/retried. Per-leg client reference, payload digest, broker-order ID, fills and reconciliation metadata remain durable. An acknowledged sell stops a sequenced basket before later buys until separately implemented reconciliation; it is not assumed filled. No unattended follow-on trades.

Review returns every exact leg, sequencing, owner/account, connection mode/version, risk results and digest. The existing authenticated HTTP dependency supplies owner identity. Confirmation requires that digest and the explicit `confirm_exact_order_or_basket` action, plus a one-use request-local human-action capability. Workers/task headers have no such capability; it is not put into outbox or Celery. Approval binds exact request/review/risk/owner/time/nonce/expiry and expires at five minutes or connection expiry, whichever is earlier. This is application enforcement, not protection against a DBA or arbitrary malicious code in the API process.

Only the explicit confirmation handler creates approval and its outbox row in the same transaction. User → selection-header → connection → intent locks serialize approval/claim against disable/disconnect/revocation. Dispatch rechecks current policy, connection, risk, all legs, frozen payload, approval and expiry after waits; locks span the bounded fake effect. A committed submitting state precedes I/O. A crash anywhere after claim is conservative uncertainty and never automatic retry. Disable commits after an already-admitted effect can wait for its fence, as documented by Stage07; instantaneous revocation is not promised.

**There is no normal-runtime registration, activation endpoint, real broker adapter, credential access, consumer for the new confirmed-intent outbox topic or real provider composition.** `/order-intents/status` reports disabled; all preparation/confirmation writes require an unavailable runtime dependency in the normal app. Synthetic HTTP tests override that dependency privately. FakeBroker is the only accepted concrete adapter. Its methods perform no SDK/network calls. Default policy uses existing execute entitlement checks; default risk resolution refuses operation. Product/provider approval or an environment toggle alone cannot activate this code.

## Release-scope financial boundary inventory

| Path / boundary | Current treatment |
|---|---|
| Zerodha `/orders`, `/orders/place-protected-market`, `/orders/place-protected-market-sequenced` | Fail503 before token lookup, quotes, audit writes or adapter calls. Existing unsafe implicit quantity/price substitutions cannot execute. Current tests assert denial; exact prior tests/source remain in accepted31 historical execution. |
| Zerodha sync/async `_request_*` | Every mutation except exact session-token exchange/revocation is denied. Encoded/unknown/order/basket paths cannot bypass the gate. Session/login implementation and credentials are unchanged. |
| Shared `require_financial_writes_allowed` | Recovery retains its original containment; all other financial calls are also disabled pending separate reviewed activation. Module toggles/manual recovery flags are insufficient. |
| Direct Polymarket CLOB inner `_place_order` / executor | Existing central financial gate runs before client construction, signing or post. |
| Direct Polymarket `_rpc_call` | Only existing `eth_call` read is allowed; send/unknown RPC methods deny before HTTP regardless of recovery mode. |
| Bullpen auto/live/copy/direct/redeem via runtime subprocess | Parser re-derives write classification at actual process fence; every write denies before process creation, including safety/reconciliation contexts. Read-only reconciliation remains constrained by existing policy. Public execution stays unavailable. |
| New synthetic confirmed-intent dispatch | Exact persisted approval only; fake adapter only; no legacy route delegates into fake composition or obtains live access. |

This inventory is the current source map and focused negative-test evidence, not an external broker certification. Whole repository source-only inventory was regenerated unchanged; it has no unresolved entries. No new module registry, ownership domain, transport credentials or live approval grant is created.

## Recovery and verification

Additive migration `order_intents_001` follows `ai_limits_001`; it only creates intent/leg tables and constraints. Populated unguarded downgrade refuses to discard evidence. Existing native controller accepts the exact Stage13 predecessor and Stage14 revision, checks every new table/column, privately preserves all order/outbox/spend/connection/import/workflow evidence, and performs child/parent cleanup plus downgrade in the same active transaction. Any failure rolls cleanup back and leaves the blocking marker. Backup provenance, manifest, fingerprint, single-transaction restore and verification-only recovery remain intact. Older helpers and runners are preserved; Stage13 runner executes at frozen31 alongside the new current Stage14 matrix. No live migration or host operation ran.

Local tests actually passed:87 focused synthetic/HTTP/transport negatives;345 combined focused+Stage13+authorization+Zerodha+containment regressions;153 native controller/helper tests (including exact columns and failed cleanup rollback);8 safe controller-runner tests;5 baseline tests; source compile and inventory check. Earlier failures remain retained externally: seven old assertions expected legacy submission/logging, followed by one stale recovery assertion; updated tests now assert earlier denial/no I/O while prior exact source remains frozen. No skip/waiver was added.

Prepared, **not executed**:7 actual Docker PostgreSQL cases (parallel create, approval clicks, duplicate delivery, disable/account-switch/revoke fences, additive migration roundtrip);20 disposable Linux PostgreSQL/systemd controller cases; fresh exact-head CI/artifacts/offline audit. The new PG job requires94 tests/zero skips. Two previously denied local readiness socket binds are not retried; full readiness fixtures are left for separately authorized CI. No genuine browser/visual acceptance is claimed. Frontend source is byte-unchanged; no frontend rebuild pass is invented.

## Safe local walkthrough and lifecycle

From this worktree, using the already installed backend development runtime:

```sh
PYTHONPATH=backend ../stage09-recovery-successor/.runtime/python/bin/python backend/scripts/stage14_synthetic_preview.py
```

This one-shot command refuses dotenv files, clears inherited environment before settings, uses import-only loopback endpoints that are never contacted, creates a disposable private SQLite database, emits the exact reviewed synthetic order/risk/account, simulates explicit human confirmation and a fake fill, and rejects worker self-approval/replay. Database is removed on exit. No listener, background job or persistent service exists; completion stops it. Stop an interrupted foreground preview with Ctrl-C. HTTP tests use the real router in an isolated in-process TestClient; this preview is not an imitation frontend or live owner-session evidence. The containing candidate and its archive hash are recorded externally after commit.

Existing real screens such as `/console/automated-rebalance` and `/console/profile/preferences` remain unchanged. They do not present a new Stage14 approval UI. UAT2 still serves Stage13, not this local source. Backend-only review uses the exact review JSON and tests; no dummy controls are added to imply live approval behavior.

Remaining gates: independent source review, explicit exact-head publication/CI permission, terminal PostgreSQL/Linux/CI with zero skips and artifact audit, separate UAT2 deployment approval with fresh Stage13 backup, permitted live checks and qualified owner acceptance. Runtime activation/live providers/trades are excluded, and Stage15 is not started. Existing US$10 allowance,21October21:04:13IST manual stop and26October retention are unchanged; no billing-cap or automatic-stop guarantee.
