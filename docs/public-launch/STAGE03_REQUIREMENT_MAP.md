# Stage03 requirement map

Base/deployed02:a2e82f0e7f36d4fdafc78f7dbe01553aca49af11. Full stages/03.md and current Library HTML p03 control this stage. PR1240 remains baseline-only; reuse Stage02 ownership queries and existing ticket/cache/session generation code. No schema migration planned. Informed progression approval and incomplete fresh browser check are recorded distinctly in STATUS.md.

| Requirement | Existing evidence / missing behavior | Implemented repair and evidence |
| --- | --- | --- |
| Detail access before accept | Stage02 job/run owner queries already enforce404/4004 before accept | Preserve; retest known/guessed IDs and no initial/later events |
| List/current access | ws_relay validates active user once; raw access JWT also accepted; no ongoing check | Existing one-use ticket extended with access/session context; current active identity/ownership/session validation at connect, per event and bounded periodic interval |
| Tenant channels | Lists already user-scoped; detail channels globally keyed by resource | Scoped producer/consumer channel names, no legacy private-detail fallback; test wrong-owner/late events |
| Origin/token logs | No WS Origin check; query ticket may enter access logs | Exact configured origin before accept; scrub query before accept/deny logs; no credential text in application errors |
| Logout/session loss | Logout already persists ActivityLog; access and refresh include iat | Reuse durable logout ledger for current-access/revocation, preserve authentication time across refresh; no new table, credentials or key |
| Redis lifecycle/reconnect | Relay has competing tasks, cleanup may miss exceptional exits; client connect can race | Finally cancel/await all tasks and close subscriber/client; client one active connection, stale callback guards and stop-on-revocation |
| Browser private state | AuthProvider purges known persisted prefixes; API dedupe session generation exists; mounted children/sockets may survive switch | Reuse cache-owner/dedupe, invalidate stale request completion, synchronous private boundary cleanup and keyed remount; extend missing private storage prefixes; test A→B/logout/late completions |
| Module revocation | Stage07 not implemented | Provide current-access authorization hook; do not claim module revocation before07 |
| Delivery | UAT2 sockets currently disabled1008 by restricted composition | Retain live simulation/owner barrier; local/CI stream tests separate from UAT2 deployed verification. Exact CI/artifact then parent-coordinated delivery; review before04 |

Code:IMPLEMENTED; local evidence: STAGE03_PREVIEW.md. Exact-head CI/deployment/verification/owner03 acceptance:PENDING. US$10 and21 October2026 21:04:13IST stop unchanged.
