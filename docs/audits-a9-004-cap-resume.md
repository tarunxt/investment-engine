# A9-004 / A9-R16 — canonical workflow spending-cap continuation

Canonical task: `6hvHGqFj8p4C4jpg`. Existing branch:
`audit7/rebalance-spend-cap-20261101`; prior head
`844a0e09d2665d94058b31ae2ecd3554330c3127`. This continues that implementation;
no replacement budget task or competing allowance was created.

Approved policy is unchanged: ₹20 per logical Zerodha workflow, ₹20 per logical
INDmoney workflow (₹40 for the pair). Retries, fanout, repairs and continuations
share the original market scope. No model or financial formula was changed.

## Fresh source reconciliation

Read-only fetched main was `8d25f34a33242adcaab092afdb07af7956f327bd`.
Auth PR1391 was open/draft at
`e161f604afe9d5a2631d833dc468e7f24b8ca778`; its separate release hold applies.
The new cap-domain work does not alter its signing configuration or auth routes.
Root test fixtures from the auth PR supply only synthetic test keys on integration.
No production credential was read, generated or changed.

Main contains F08 analysis-only policy, unknown-funds preservation and financial
calculation repairs absent from the older cap base. They must not be replaced by
the old cap versions. A non-mutating merge preview identified content conflicts:

- `backend/app/domains/runs/router.py`
- `frontend/app/console/dashboard/_components/RebalanceWorkflowSections.tsx`
- `frontend/services/api.ts`
- `frontend/types/api.ts`

Other automatically merged files still need semantic review. In particular, keep
`side_effect_policy` in both label request and response, retain the native
analysis-only control and its acknowledgement check, and add cap authorization
fields rather than replacing that service signature with the older cap signature.
UUID replay must return the original frozen side-effect policy and must never
restart the prior sequence. Cap consent is not notification/export consent.

Migration wiring also remains a coordinator integration step: current main has
`audit7_run_policy_001` after `recommendation_audit_001`, while the unreleased cap
revision independently starts from `recommendation_audit_001`. Do not deploy with
multiple heads. Reconcile the unreleased cap lineage with F08 before running any
migration. This change adds `rebalance_spend_refund_002` after the cap revision.
No Alembic migration was executed against any database.

## New implementation in this continuation

- Admission evidence now requires explicit finite input/generated-token,
  server-tool, transport-attempt and total-duration ceilings, including hidden
  reasoning/tools, plus a reviewed enforcement reference. A descriptor is not a
  provider certification: the trusted resolver still rejects every live adapter.
- Tariff/FX validity must cover the maximum request/retry duration. Unknown or
  incomplete evidence rejects before the mocked transport is called.
- Settlement evidence must cover all possibly billed transport attempts and
  actual INR settlement, with matching tariff/FX versions, currency and included
  taxes/fees. A final response's usage/request ID is insufficient. Missing proof
  retains the full reservation and suspends the scope.
- Confirmed settlement stores a hash of the all-attempt evidence and an INR
  settlement reference. Conflicting later receipts do not rewrite the original
  charge; they freeze the scope. Later uncertain calls cannot downgrade a prior
  bound-breach or settlement-conflict freeze and accidentally reopen spending.
- Confirmed refunds use an append-only credit table with owner/original-charge
  checks, exact amount validation, receipt idempotency, cumulative credit limits
  and evidence hashes. No public endpoint or billing settings route was added.
  Credits do not erase gross incurred usage, release uncertain reservations,
  clear a breach, or replenish the original workflow allowance. Audit12 can
  report gross charge and confirmed credits separately. Refunds from unrelated
  scopes, estimates, foreign currency or unsettled promises are rejected.

## Recommendation status and acceptance evidence

| Item | Actual status | Remaining requirement |
| --- | --- | --- |
| A9-004-A01 | Existing canonical identity, native per-workflow grants and approved policy preserved; latest main/auth sources reconciled read-only. Unknown price/FX remains denied. | Coordinator resolve F08/shared-file and migration integration without resetting scopes. |
| A9-004-A02 | Finite evidence contract tightened; existing durable atomic reservations and actor/market binding retained. Every live adapter stays blocked before paid I/O. | A11 owns creation/input/fanout/queue/concurrency admission and outbox; execution-fence owner owns dispatch deadline/cancellation. Their interfaces were not available through this worker's agent-message channel. No arbitrary numeric resource limits were invented. Real adapter enforcement proofs remain missing. |
| A9-004-A03 | Added all-attempt INR proof validation, immutable evidence hash, conflicting-settlement freeze, freeze preservation, and append-only refund reconciliation. Cancellation/partial-use tests preserve incurred cost. | Actual tariff, all-transport charge evidence and settlement terms are unavailable; no invoice guarantee or adapter enabled. |
| A9-004-A04 | Offline actual-ledger/mocked-provider tests and existing provider/recovery regressions run. No financial formulas, holdings/context, model selection or quality checks changed. | Fresh PostgreSQL races and combined current-main/auth/A10 integration checks remain required. No paid benchmark or measured savings claim. |
| A9-R16 | Pinned SDK retry/timeout defaults checked without constructing clients or making network requests. | Actual authorized provider quotas and billing terms remain unverified; no account access was attempted. |

## SDK evidence (installed pinned source, not account quotas)

- OpenAI `2.35.1` and Anthropic `0.100.0`: two SDK retries by default,
  connect timeout five seconds and read/write/pool timeouts 600 seconds. Existing
  DeepSeek uses the OpenAI client and inherits this behavior. One metered SDK
  invocation can therefore conceal several transport attempts. Timeouts do not
  prove remote cancellation or a total billing deadline.
- Google GenAI `2.0.1`: `HttpOptions.retry_options=None` selects one attempt in
  the inspected retry helper. Explicit default retry options select five;
  the existence of a five-attempt constant does not establish five active tries.
  The adapter also has key rotation. No explicit total timeout is supplied.
- Tavily `0.7.24`: search defaults to 60 seconds per transport. This does not cap
  the number of separate tool searches in the workflow.

These are tested version contracts, not complete provider/request/INR upper-bound
certifications. No absence of an explicit configuration is described as unlimited.

## Verification and exact holds

**184 passed, five skipped**, with twelve dependency/deprecation warnings, in the
combined cap/provider/metering/recovery/sequence suite. This continuation adds39
tests (38 passed and one PostgreSQL-only case skipped); the other four skipped
cases are the existing PostgreSQL races. Compileall and `git diff --check` passed.
New tests cover finite-limit
rejection before I/O, tariff validity over retries, incomplete transport/FX/tax
proof, confirmed all-attempt evidence, partial/cancelled consumption, conflicting
settlement, immutable credits and duplicate-refund concurrency. The latter needs
PostgreSQL; skipped tests are not claimed as verified.

The environment did not retain the previous disposable PostgreSQL binaries.
Package bootstrap could not locate PostgreSQL, and updating temporary package
lists against the configured Debian snapshot feeds returned HTTP403. No alternate
feed, privilege escalation or production database was used to bypass this block.
SQLite outcome tests continued independently. This is a tooling/network block,
not an automatic approval-review rejection.

No shared job/run creation, outbox, provider adapter, worker task or metering file
was edited in this continuation. Existing scope/attempt identities and reservation
keys are unchanged. A11/A12 integration must retain the cap context derived from
persisted owner/market/sequence and call admission before each potentially billed
boundary; cancellation/fencing must never automatically release ambiguous spend.

Rollout is **HELD**. Independent cap-domain code is usable for integration/testing;
normal capped workflows remain unavailable. No provider/tariff/FX/account setting,
paid run, trade, email/export, merge or deployment was performed.
Coordinator alone owns combined review, merge and deployment under the existing
release containment. No new budget decision is requested.

## Private main reconciliation after publication hold

The four content conflicts listed above are now resolved locally against exact
main `8d25f34a33242adcaab092afdb07af7956f327bd`; this reconciliation is not pushed.
The server label boundary keeps F08's schema-readiness guard and frozen policy
on first creation and UUID replay. The service retains its analysis-only argument
and adds the spend authorization argument. Pending browser records now persist
the original policy with the UUID; retrying with a different checkbox value cannot
replace the frozen payload. A missing or different server acknowledgement stops
before any stages start. All financial repair files checked against main remain
byte-identical. No peer admission/fencing changes were merged or overwritten.

The unreleased cap migration now follows `audit7_run_policy_001` in source;
`rebalance_spend_refund_002` follows the cap. A static graph test reads both ordinary
and annotated Alembic revision assignments and verifies one local source head.
This is not an Alembic/database execution. The peer dispatch migration also starts
from F08: the coordinator must reconcile the resulting sibling heads when those
lanes are combined. The local single-head test does not certify that future merge.

Private reconciliation verification: 316 backend tests passed, five PostgreSQL-only
skips, 12 subtests passed. This includes cap, F08 suppression/readiness, frozen-final
recomputation, score arithmetic, unknown holdings/funds, US Threats, provider/metering
and recovery regressions. Frontend workflow tests:72 passed, one skipped; policy
checks:8 passed. The actual React consent fixture passed in Chromium against its
local synthetic API with external requests blocked. Full TypeScript check passed.
Next.js16.2.5 webpack production build and postbuild runtime-artifact checks passed. No apt retry or alternate
package feed was used after the previously recorded HTTP403.

### Returned shared-lane contract evidence

Read-only inspected admission/result commit
`e7e41e2d9bddc02749225a0def3ca96b4f8d80bd`, dispatch/migration commit
`f43b04345551d122ef075bc4a18d44e97a456593`, and consumer-fence commit
`72ca85e614e612b9fd50a1e4d066d08e64620b5d`.

| Boundary | Contract to preserve during coordinator integration |
| --- | --- |
| Producer admission | Preserve existing job ID, actor, portfolio, sequence, label, complete prompt/model/source fingerprint and UTC ETA. Its actor/operation/idempotency key is distinct from the cap's workflow-grant UUID. A new producer admission does not grant a new allowance. |
| Outbox | One committed obligation per child and stable outbox UUID delivery ID remain peer-owned. Delivered/uncertain/dead-letter/terminal state is not billing settlement and must never release an ambiguous reservation. Redelivery or resumed publication resolves the same job/scope. No relay activation here. |
| Consumer fence | Preserve `jobs.runtime_metadata_json.execution_claim` and owner token/attempt/delivery/pending-call/history fields. The cap does not write that metadata. Admit the consumer owner, resolve the persisted cap context before paid work, and retain both independently committed gates. Never hold job/scope DB locks during network I/O. |
| Threads and retries | The peer's `copy_context` propagation must also preserve the cap ContextVar in provider threads. Cap identity remains job/retry/call within the original workflow scope; ownership-attempt changes cannot renew allowance. Restore context in finally and preserve heartbeat/owner cleanup. |
| Ambiguity | Ownership loss blocks calls/results; ambiguous provider acceptance blocks replay. Missing INR settlement still retains spend even if a job is cancelled or terminal. A cap denial before I/O and a settlement failure after possible I/O need phase-aware classification; do not convert the latter into a safe pre-provider retry. |
| SDK boundary | The fence checks adapter entry; hidden SDK retries/tool/repair charges still require the cap's certified finite all-attempt bound. Neither owner fencing nor stable Celery task ID proves external idempotency or invoice amount. All live adapters remain blocked. |
| A12 accounting | Preserve existing delivery/retry usage identity, phases and hashes. ConfirmedCharge requires matching tariff/FX versions, all transport receipts, actual INR settlement and included taxes/fees. Invoice actuals, estimates, gross charges and confirmed credits remain separate. No final-response-only proof or savings claim. |

These are source-backed integration requirements, not acknowledgements from the
peer workers or proof that the lanes have been jointly tested. Their source files
remain lane-owned. Coordinator owns the combined migration and worker integration.
