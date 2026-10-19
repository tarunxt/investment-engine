# Restricted UAT2 entry-point composition

Companion to ROUTE_MATRIX.md. The generated scanner inventories all source decorators, workers/schedulers and pages, but its mounted/unmounted labels describe app.main. Actual UAT2 uses app.uat2.main, whose separate composition is recorded here rather than implying that every production router is enabled in UAT2. This is source review, not live ingress certification.

The complete auth router is included, with existing UAT2 exact-owner checks before Google provisioning/session use and password/register/forgot/reset paths denied. The synthetic router has get_current_user at router level. No owner, role, cookie, signing-key, provider, cgroup, budget or access setting is changed by Stage01 integration.

| Method | UAT2 path | Source | Composition / authority |
| --- | --- | --- | --- |
| GET | /auth/google/config | backend/app/domains/auth/router.py:45 | Real auth router; UAT2 owner and alternate-auth guards retained |
| POST | /auth/google | backend/app/domains/auth/router.py:53 | Real auth router; UAT2 owner and alternate-auth guards retained |
| POST | /auth/register | backend/app/domains/auth/router.py:77 | Real auth router; UAT2 owner and alternate-auth guards retained |
| POST | /auth/login | backend/app/domains/auth/router.py:123 | Real auth router; UAT2 owner and alternate-auth guards retained |
| POST | /auth/refresh | backend/app/domains/auth/router.py:158 | Real auth router; UAT2 owner and alternate-auth guards retained |
| POST | /auth/logout | backend/app/domains/auth/router.py:186 | Real auth router; UAT2 owner and alternate-auth guards retained |
| POST | /auth/websocket-ticket | backend/app/domains/auth/router.py:196 | Real auth router; UAT2 owner and alternate-auth guards retained |
| GET | /auth/me | backend/app/domains/auth/router.py:206 | Real auth router; UAT2 owner and alternate-auth guards retained |
| POST | /auth/forgot-password | backend/app/domains/auth/router.py:213 | Real auth router; UAT2 owner and alternate-auth guards retained |
| POST | /auth/reset-password | backend/app/domains/auth/router.py:230 | Real auth router; UAT2 owner and alternate-auth guards retained |
| PUT | /auth/password | backend/app/domains/auth/router.py:257 | Real auth router; UAT2 owner and alternate-auth guards retained |
| GET | /auth/profile | backend/app/domains/auth/router.py:278 | Real auth router; UAT2 owner and alternate-auth guards retained |
| PUT | /auth/profile | backend/app/domains/auth/router.py:302 | Real auth router; UAT2 owner and alternate-auth guards retained |
| GET | /uat2/status | backend/app/uat2/router.py:15 | UAT2 synthetic router; router-level get_current_user enforces exact owner |
| GET | /zerodha/portfolio | backend/app/uat2/router.py:24 | UAT2 synthetic router; router-level get_current_user enforces exact owner |
| GET | /zerodha/status | backend/app/uat2/router.py:29 | UAT2 synthetic router; router-level get_current_user enforces exact owner |
| POST | /zerodha/orders | backend/app/uat2/router.py:37 | UAT2 synthetic router; router-level get_current_user enforces exact owner |
| GET | /dashboard/summary | backend/app/uat2/router.py:42 | UAT2 synthetic router; router-level get_current_user enforces exact owner |
| POST | /uat2/ai | backend/app/uat2/router.py:65 | UAT2 synthetic router; router-level get_current_user enforces exact owner |
| GET | /uat2/ai/{task_id} | backend/app/uat2/router.py:72 | UAT2 synthetic router; router-level get_current_user enforces exact owner |
| POST | /uat2/email | backend/app/uat2/router.py:87 | UAT2 synthetic router; router-level get_current_user enforces exact owner |
| GET | /uat2/export | backend/app/uat2/router.py:94 | UAT2 synthetic router; router-level get_current_user enforces exact owner |
| GET | /indmoney-us/portfolio and /indmoney-us/portfolio/{snapshot_id} | backend/app/uat2/main.py filtered route append | Only these existing GET routes are appended; ingestion/price-fetch routes excluded; real owner dependency retained |
| GET | /health | backend/app/uat2/main.py | Simulation health; external barrier still required |
| GET/POST/PUT/DELETE/PATCH/OPTIONS | /{path:path} fallback | backend/app/uat2/main.py | Explicit UAT2_UNAVAILABLE / 503; no production router fallthrough |
| WebSocket | /{path:path} fallback | backend/app/uat2/main.py | Close 1008 before subscription; live WS functionality unavailable |
| Worker | uat2.fake_ai | backend/app/uat2/worker.py | Dedicated uat2_simulation queue, deterministic fake AI, bounded time/retry, no production tasks |
| Scheduler | none | backend/app/uat2/worker.py | beat_schedule={} retained; no Beat startup |
| Export | GET /uat2/export | backend/app/uat2/router.py | Synthetic local CSV only; authenticated exact owner |
| Email | POST /uat2/email | backend/app/uat2/router.py | Local file sink only; no SMTP/provider |

The dedicated host barrier must cover all pages/assets/API/WS, independent host-only cookies/signing keys and no-egress sandbox must still be verified live by the parent/UAT2 task. Baseline's 4 default FastAPI documentation routes refer to app.main; UAT2's docs/redoc/openapi are explicitly disabled. Localhost auth/profile preview uses its own opt-in script and synthetic accounts, never the public UAT2 identity allowlist. No later-stage modules or tenant repairs are implied.

Historical pre-sync guard hashes and the then-current c40f112d tree comparison are preserved in evidence/stage01-uat2-source-review-20261019.json. Current source incorporates reviewed reset fix79acc235 and synthetic India fix503f86ee; use current entrypoints.json hashes and Git identities. Runtime backend/frontend/controller content matches the published UAT2 source503f86ee; the additional deployment-tree change is the mocked reset regression, not a guard/access change. The regenerated source inventory includes 260 HTTP, 5 WebSocket, 43 worker, 16 scheduler, 42 export, 32 background, 7 lifecycle, 66 page and 25 frontend entries. These counts cover source alternatives, not enabled public UAT2 surfaces.
