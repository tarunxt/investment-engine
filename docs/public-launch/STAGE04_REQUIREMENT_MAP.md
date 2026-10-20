# Stage04 requirement map

Base: deployed Stage03 a1643521a08ce221512579297ce3724c6d21b24f. Owner said "all good. move to next stage" on20 October2026. This accepts03/progression; the parent explicitly reports live server/anonymous checks and local/CI browser-boundary evidence, with no fresh signed-in UAT2 walkthrough. Complete stages/04.md verified exact against unchanged authoritative Library HTML p04; no remembered outline substituted.

| Requirement | Current source | Implementation / required evidence |
| --- | --- | --- |
| Durable owner/operation/key + digest/result | create_job.py uses owner-prefixed Redis keys, no digest/DB constraint | One durable idempotency binding table referencing existing owned Job; additive outbox retry/attempt fields; unique owner/operation/key digest; canonical full request digest;409 conflicts; no duplicate ownership registry |
| Concurrent precheck race / locks | Redis precheck outside lock; prompt-prefix fallback | Database uniqueness arbitrates creation in one transaction with Job and existing outbox; no prompt lock, no Redis authority |
| Replay ownership / old cache | Cached dict returned without owned DB query | Recheck Job owner on each replay; ignore old global/owner Redis entries; fail closed on missing/corrupt binding |
| Dispatch/recovery | job+outbox committed then direct publish; referenced general outbox relay absent | One versioned existing-outbox dispatch path, bounded worker recovery; retry broker failures and uncertain publications; deduplicating PostgreSQL consumer guard; terminal redelivery skip; no exactly-once provider claim |
| Failure semantics | Broker/cache failures after commit can lose response/delivery | Atomic logical operation; same key keeps same job across failure/restart; no automatic key expiry/deletion; define pending/scheduled/processing/error behavior and ambiguity |
| Real tests | Existing owner replay is sequential with fake Redis | Real PostgreSQL concurrent equal/conflicting/different-owner operations; actual Redis loss/restart; commit-before-dispatch crash and duplicate delivery; isolated migration up/down/up inside backend Docker container |
| Review/delivery | Stage03 actual preview and native artifact valid | Separate Stage04 branch/draft, targeted regression plus unchanged CI gates, actual synthetic preview, exact retained Linux bundle/receipt; existing UAT2 executor owns migration/deployment after current READY/limits check |

Stage14 financial order deduplication, Stage05 and public execution remain outside04. UAT2 owner-only/simulation and restricted mutations/sockets remain closed; local/CI fake job tests do not expand live access. No production/main deployment, credentials, permissions, infrastructure or US$10/21Oct2026 21:04:13IST limit changes.
