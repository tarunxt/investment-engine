# Restricted UAT2 entry-point composition

Companion to ROUTE_MATRIX.md. The generated scanner inventories all source decorators, workers/schedulers and pages, but its mounted/unmounted labels describe app.main. Actual UAT2 uses app.uat2.main, whose separate composition is recorded here rather than implying that every production router is enabled in UAT2. This is source review, not live ingress certification.

The complete auth router is included, with existing UAT2 exact-owner checks before Google provisioning/session use and password/register/forgot/reset paths denied. The synthetic router has get_current_user at router level. No owner, role, cookie, signing-key, provider, cgroup, budget or access setting is changed by Stage01 integration.

| Method | UAT2 path | Source | Composition / authority |
| --- | --- | --- | --- |
| GET | /auth/google/config | backend/app/domains/auth/router.py:47 | Real auth router; UAT2 owner and alternate-auth guards retained |
| POST | /auth/google | backend/app/domains/auth/router.py:55 | Real auth router; UAT2 owner and alternate-auth guards retained |
| POST | /auth/register | backend/app/domains/auth/router.py:79 | Real auth router; UAT2 owner and alternate-auth guards retained |
| POST | /auth/login | backend/app/domains/auth/router.py:125 | Real auth router; UAT2 owner and alternate-auth guards retained |
| POST | /auth/refresh | backend/app/domains/auth/router.py:160 | Real auth router; UAT2 owner and alternate-auth guards retained |
| POST | /auth/logout | backend/app/domains/auth/router.py:191 | Real auth router; UAT2 owner and alternate-auth guards retained |
| POST | /auth/websocket-ticket | backend/app/domains/auth/router.py:201 | Real auth router; UAT2 owner and alternate-auth guards retained |
| GET | /auth/me | backend/app/domains/auth/router.py:215 | Real auth router; UAT2 owner and alternate-auth guards retained |
| POST | /auth/forgot-password | backend/app/domains/auth/router.py:222 | Real auth router; UAT2 owner and alternate-auth guards retained |
| POST | /auth/reset-password | backend/app/domains/auth/router.py:239 | Real auth router; UAT2 owner and alternate-auth guards retained |
| PUT | /auth/password | backend/app/domains/auth/router.py:266 | Real auth router; UAT2 owner and alternate-auth guards retained |
| GET | /auth/profile | backend/app/domains/auth/router.py:287 | Real auth router; UAT2 owner and alternate-auth guards retained |
| PUT | /auth/profile | backend/app/domains/auth/router.py:311 | Real auth router; UAT2 owner and alternate-auth guards retained |
| GET | /uat2/status | backend/app/uat2/router.py:15 | UAT2 synthetic router; router-level get_current_user enforces exact owner |
| GET | /zerodha/portfolio | backend/app/uat2/router.py:24 | UAT2 synthetic router; router-level get_current_user enforces exact owner |
| GET | /zerodha/status | backend/app/uat2/router.py:29 | UAT2 synthetic router; router-level get_current_user enforces exact owner |
| GET | /zerodha/login-url | backend/app/uat2/router.py:37 | UAT2 synthetic router; router-level get_current_user enforces exact owner |
| GET | /zerodha/orders | backend/app/uat2/router.py:45 | UAT2 synthetic router; router-level get_current_user enforces exact owner |
| POST | /zerodha/orders | backend/app/uat2/router.py:50 | UAT2 synthetic router; router-level get_current_user enforces exact owner |
| GET | /dashboard/summary | backend/app/uat2/router.py:55 | UAT2 synthetic router; router-level get_current_user enforces exact owner |
| POST | /uat2/ai | backend/app/uat2/router.py:78 | UAT2 synthetic router; router-level get_current_user enforces exact owner |
| GET | /uat2/ai/{task_id} | backend/app/uat2/router.py:85 | UAT2 synthetic router; router-level get_current_user enforces exact owner |
| POST | /uat2/email | backend/app/uat2/router.py:100 | UAT2 synthetic router; router-level get_current_user enforces exact owner |
| GET | /uat2/export | backend/app/uat2/router.py:107 | UAT2 synthetic router; router-level get_current_user enforces exact owner |
| GET | /indmoney-us/portfolio and /indmoney-us/portfolio/{snapshot_id} | backend/app/uat2/main.py filtered route append | Only these existing GET routes are included; ingestion/price-fetch routes excluded; real owner dependency retained |
| GET | /jobs | backend/app/domains/jobs/router.py:72 | Actual owner-scoped handler; active identity/exact UAT2 owner; DB owner/count/relationship predicates |
| GET | /jobs/{job_id} | backend/app/domains/jobs/router.py:98 | Actual owner-scoped handler; active identity/exact UAT2 owner; DB owner/count/relationship predicates |
| GET | /runs | backend/app/domains/runs/router.py:959 | Actual owner-scoped handler; active identity/exact UAT2 owner; DB owner/count/relationship predicates |
| GET | /runs/{run_id} | backend/app/domains/runs/router.py:992 | Actual owner-scoped handler; active identity/exact UAT2 owner; DB owner/count/relationship predicates |
| GET | /runs/auto-rebalance-history?portfolio=india or indmoney_us | backend/app/domains/runs/router.py list_auto_rebalance_history | Explicit read-only mount before run-ID route; authenticated owner, scoped related records; no acquisition/readiness bypass |
| GET | /runs/auto-rebalance-history/{portfolio}/{sequence} | backend/app/domains/runs/router.py get_auto_rebalance_history_detail | Exact owned history only; foreign/corrupt related evidence excluded; stage mutation siblings remain unmounted |
| GET | /health | backend/app/uat2/main.py | Simulation health; external barrier still required |
| GET/POST/PUT/DELETE/PATCH/OPTIONS | /{path:path} fallback | backend/app/uat2/main.py | Explicit UAT2_UNAVAILABLE / 503; no production router fallthrough |
| WebSocket | /{path:path} fallback | backend/app/uat2/main.py | Close 1008 before subscription; live WS functionality unavailable |
| Worker | uat2.fake_ai | backend/app/uat2/worker.py | Dedicated uat2_simulation queue, deterministic fake AI, bounded time/retry, no production tasks |
| Scheduler | none | backend/app/uat2/worker.py | beat_schedule={} retained; no Beat startup |
| Export | GET /uat2/export | backend/app/uat2/router.py | Synthetic local CSV only; authenticated exact owner |
| Email | POST /uat2/email | backend/app/uat2/router.py | Local file sink only; no SMTP/provider |

The dedicated host barrier must cover all pages/assets/API/WS, independent host-only cookies/signing keys and no-egress sandbox must still be verified live by the parent/UAT2 task. Baseline's 4 default FastAPI documentation routes refer to app.main; UAT2's docs/redoc/openapi are explicitly disabled. Localhost auth/profile preview uses its own opt-in script and synthetic accounts, never the public UAT2 identity allowlist. No later-stage modules or tenant repairs are implied.

Historical pre-sync guard hashes and the then-current c40f112d tree comparison are preserved in evidence/stage01-uat2-source-review-20261019.json. Current source incorporates reviewed reset fix79acc235 and synthetic India fixes503f86ee and8f2d24e5; use current entrypoints.json hashes and Git identities. Runtime backend/frontend/controller content matches the published UAT2 source8f2d24e5; the additional deployment-tree change is the mocked reset regression, not a guard/access change. The regenerated source inventory includes 262 HTTP, 5 WebSocket, 43 worker, 16 scheduler, 42 export, 32 background, 7 lifecycle, 66 page and 25 frontend entries. These counts cover source alternatives, not enabled public UAT2 surfaces.

Stage02 adds actual read-only jobs/runs handlers by filtered router inclusion. Their POST/cancel/export routes remain unavailable503 and WebSockets1008 in UAT2. No provider dispatch or extra test identity is enabled. Route identity comes from get_current_user; public multi-user remains closed. The prior source503/8f comparison paragraph above is Stage01 historical provenance; current ownership changes are mapped in STAGE02_REQUIREMENT_MAP.md.


Stage05 preserves this restricted composition. Its runtime/sports/cost routers remain unmounted and unavailable503 in UAT2; the full-application126 runtime routes and13 Next BFF handlers are verified separately with private synthetic HTTP/SQL tests. The additive admin-role table does not grant access by itself. Before any live migration, run the packaged read-only Stage05 role-equivalence preflight under the existing UAT2 runtime; stop on any proposed cost membership or ambiguous/invalid mapping until specific approval. No new owner identity, role, cookie, runtime, route or financial flag is enabled by generic Stage05 authority.

## Stage07 lifecycle composition supplement

The restricted mount set/owner allowlist remains intact. GET/PATCH `/me/modules`, POST `/me/modules/disable-impact`, and POST `/me/modules/{module_id}/resume-schedules` are real authenticated management routes. The resume endpoint permits only eligible analysis modules, starts no work, and cannot resume trading. All optional modules remain unavailable under restricted UAT2; no new domain router or public account is added.

Existing synthetic read-only portfolio/status/dashboard/order-history fixtures and real owned Job/Run history remain reviewable. Synthetic POST order/AI/email and export operations now pass canonical optional-module policy, closing when default-off; missing fake support never falls back to a real provider. The fake worker requires a persisted owned Job binding. The explicit standalone private-file smoke is not an HTTP exception or live policy override; see STAGE07_COVERAGE.md. Source-only composition is separate from deployed/browser acceptance.

## Stage08 presentation supplement

The existing module-management response now includes a typed presentation manifest; no duplicate registry or capability grant. Authenticated GET `/me/modules/safety-activity` shows bounded owned recorded activity independently of selection; accepted-intent SQL is restricted to the existing active ADMIN role and remains explicitly incomplete reconciliation. GET `/me/modules/resource-access/{kind}/{resource_id}` reveals only owned access metadata before detail pages can mount, with identical foreign/missing404. No new optional operation/domain router or public identity is mounted. Core account, connection readiness and safety UI remain available; every optional card is unavailable in restricted UAT2. Positive module combinations use local/private synthetic facts only. No live owner module toggling is part of this implementation review.

## Stage 16 local source addition (not deployed)

The restricted composition prepares only these additional core safety reads. They authenticate the existing owner and filter persisted records by that user independently of optional module selection. No runtime, broker call, approval, retry, cancel or close is mounted.

| Method | Path | Scope |
| --- | --- | --- |
| GET | /order-intents/reviews | At most 50 owner intents, unresolved first; masked exact instructions, recorded approval/fill state and warnings |
| GET | /order-intents/reviews/{id} | Same owner projection; missing/foreign IDs return identical 404 |
| GET | /order-intents/positions | Whitelisted historical owner holdings/net/day snapshot observations; no current-account or live completeness inference |

All three return private/no-store. The ordinary app's optional read-runtime dependency is absent; only the network-denied local preview overrides it. The existing production submission runtime stays 503/unavailable. Owner/session generation resets private frontend lifetimes. Historical operator role/ownership restrictions remain unchanged.
