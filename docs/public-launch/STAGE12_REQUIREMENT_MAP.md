# Stage12 requirement map

Canonical specification: [stages/12.md](stages/12.md), "Move rebalance orchestration to durable server workflows". Stage11 prerequisite is accepted with the qualification recorded in STATUS. Base is `7c210e7b24dc2a6012daf98844a7279767e9a9df`. Read-only current-main observation: `0c6e61e524c7a87c7b9ea79342f17b14a45e97a1`; PR1240 remains draft/open, head `ddefd7306003dc8e4e662d3b88abe167da77f036`, branch `codex/stage01-preview-recovery-20261019`. No other task's source was integrated.

| Requirement | Existing infrastructure reused | Stage12 implementation and evidence |
|---|---|---|
| Server graph | Workflow/stage records and canonical manual graph | `analysis_workflows/service.py`: sync → threats → swing → rebalance → technical → actionables; persisted dependency/result hashes; browser never dispatches later stages. |
| Ownership and immutable versions | User/module lock, connection records, accepted INDmoney snapshots | `runtime.py`, `models.py`: owner/module/connection and source fingerprints, exact snapshot content, model/prompt plan, ORM immutable input guard. Application enforcement is not DBA-proof. |
| Durable transaction dispatch | Existing Outbox and Stage04 job dispatcher/consumer exclusion | `dispatch.py`, runs/tasks.py and modules transport: bounded relay, dispatch locator only, atomic next-message/checkpoint, duplicate execution exclusion. No new broker or scheduler infrastructure. |
| Retry/control/history | Existing durable job cost/attempt ledger | bounded transient retry3, max300s wait, total-attempt history survives explicit retry/resume; CAS control version; private owner history and safe cancel after module disable. |
| Every effect policy checked | Existing synchronous/asynchronous side-effect fences | `effects.py` resolves persisted job/workflow/stage and fresh input/model/module binding within those fences; no order/email/export side effect added. |
| Scheduled analysis | Existing opted-in module schedule policy and due outbox | Explicit one-shot tick admission with `(owner,schedule ID,due instant)` dedup, timezone/calendar version and skip policy, maxlateness≤3600s; re-enable cannot replay obsolete generation/module version. No recurring schedule is silently enabled. |
| Real source validation | Stage11 accepted-only integrity guard; current integration version/token | `owned_source` refuses stale/legacy/unaccepted/other-owner/current-version mismatch. Preview alone injects public fake source and deterministic zero-cost adapter. |
| Actual UI | Existing automated-rebalance page, API client and authenticated session | ServerAnalysis observer/control panel, owner/session lifetime reset, no automatic orders; fix single-selected-module crash in existing manual cards. Existing manual calculations and financial routes remain in place. |
| Recovery | Existing private backup/controller/markers/constrained migration unit | exact `durable_analysis_001` → `indmoney_integrity_001`; preserve full workflows/stages/jobs/outbox plus earlier connection/import evidence; verify exact baseline fingerprint before restart. |
| Crash/browser/duplicates | Existing SQLite fixtures plus disposable PG/Linux harness | Local63 transaction/HTTP/effect tests, seven observer tests; real PG4 migration/concurrency and Linux20 prepared but NOT_RUN. |

No duplicate module/ownership registry or new workflow tables. Migration extends the two existing audit tables. No provider calls, network grants, live tokens, automatic orders, new packages or paid actions. Tests use isolated synthetic identities and storage.
