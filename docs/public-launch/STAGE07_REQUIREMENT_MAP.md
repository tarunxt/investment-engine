# Stage07 requirement map and start

Started20October2026 after owner explicitly reviewed/accepted06 and authorized07: “Hmm. ठीक है, Stage 6 मैंने review कर लिया है, Stage 7 को process करवाओ”. Separate branch codex/stage07-module-lifecycle-20261020/worktree task-5/stage07-module-lifecycle from exact deployed f985ea727eb04d140f5794d95880be50418ff1fb. Prior worktrees remain untouched.

Full stages/07.md is authoritative: backend lifecycle enforcement, not Preferences UI. Stage08 is Preferences/filtered navigation. Earlier06 commentary/ledger references assigning UI to07 were mistaken and are superseded by these complete saved specifications. No08 implementation is authorized.

Prerequisite06: exact PR1247 source, all three CI workflows and retained native bundle/receipt verified. Parent reports independent93 policy/isolation+8 PostgreSQL checks and sole executor deployment/live migration user_modules_001 at11:31:22IST;8 services active. This task independently checked live signed-in Chrome Preferences current buildf985ea727eb0, ten exact modules/default-off/no capabilities, Jobs/refresh and Runs/Bullpen unavailable. Owner then accepted06. These supersede historical06 pending entries below.

| Requirement | Reuse and required work |
| --- | --- |
| One policy/owner source | Reuse modules registry/policy/store, existing Job/Run/domain owner fields; no new ownership registry. |
| Atomic selections + outbox | Existing patch CAS/transaction and infrastructure outbox; add versioned selection events in the same commit, idempotent/missed-event-safe processing. |
| Enqueue/start/transition/effects | Existing job use cases, durable relay/consumer guards, RecoveryTask, provider/export/notification boundaries; fresh current account/module/connection facts, server-derived persisted attribution. |
| Disable and races | Shared per-owner DB synchronization with defined linearization; queued cancellation, cooperative running stop and paused schedules; stale payloads/repeated events must not restore work. |
| Re-enable | Retain data/config/history/connections; no automatic schedule/trading restart. Disconnect remains separate. |
| Safety operations | Explicit route/task reconciliation/cancel/history classification; preserve existing owner/operator constraints. No all-jobs or ADMIN exemption, no auto-liquidation. |
| Cache/streams/schedules | Fresh SQL checks rather than stale allows, current-policy stream termination, eligible-user schedule enumeration rather than stored-token iteration. |
| Evidence | Synthetic lifecycle/race/missed-event/toggle/two-tabs/recovery tests; actual Docker PostgreSQL migration/concurrency; real Next/FastAPI preview. Existing sole executor owns UAT2 READY/budget checks/deployment. |

No production/AWS/old-UAT action, security/access expansion, credentials, real provider/order/email/paid AI, new commitment, or extension of US$10 total/21Oct2026 21:04:13IST stop. Backend-only stage: existing real screens plus API/fake-work evidence, no dummy UI.
