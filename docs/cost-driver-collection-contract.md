# Cost-driver collection contract (A12-003)

Source-only proposal. No runtime migration, collection activation, infrastructure
change, paid call or recovery operation is authorized by this change. Independent
review and coordinated deployment acceptance remain required.

GET routes read only existing snapshots. Missing data stays unknown. Redis or
ledger failure never causes GET to collect. Current and historical snapshot TTLs,
stale-good retention and source collection time remain distinct from viewing time.

Explicit POST collection first commits a per-month/mode intent in the existing
SQL database, then acquires the Redis ownership token and existing cooldown.
Admission is serialized by the table primary key and conditional SQLAlchemy UPDATE.
The durable cooldown survives Redis state loss. Before every provider invocation,
a committed inflight marker records that acceptance may become uncertain. Only a
returned response and acknowledged ledger update clear that marker. SDK retries
are disabled; request counts and fixed query/page caps remain separate safeguards.

A process crash leaves its active intent unresolved. A transport exception,
cancellation or ambiguous ledger acknowledgement leaves active/uncertain state;
no second collector is admitted even if Redis loses every key and the cooldown
expires. Normal completion can mark an intent idle only when no request remains
inflight. Redis ownership loss still stops further work and snapshot publication.
These checks do not cancel or fence a provider request already issued; the durable
intent prevents replacement admission while its acceptance remains unresolved.

There is no TTL, takeover, reset endpoint, cleanup schedule or automatic recovery.
False-positive blocking is intentional: a crash immediately after durable admission
but before any provider request still needs operator review. No account identifiers,
credentials, provider payloads or billing amounts are stored in the intent ledger.

## Migration and deployment gates

`a12_collection_intent_001` is additive source only, based on the branch's current
migration head. Review/rebase its parent against integration main before any
future migration. Alembic has not been run. Missing schema or unavailable storage
makes POST return 503 before provider dispatch; passive GET remains usable.
Automatic downgrade is refused because erasing unresolved intent would reopen
admission. No production schema/configuration/privilege changes have been made.

Synthetic SQLite fixtures and isolated official PostgreSQL 18.6 acceptance exercise
real committed SQLAlchemy operations, unique-key races, separate processes, Redis
loss, crashes, cancellation, response loss after remote acceptance, rollbacks and
lost commit acknowledgements. The PostgreSQL fixture is network-disabled and uses
only a private Unix socket and per-test schemas. An independent transaction proves
the inflight marker is committed before the synthetic transport boundary. These
tests do not establish the production durability/failover contract or execute the
Alembic migration. Those remain release acceptance gates.

## Exact safety assumptions and unresolved policy

All collection processes must use this implementation and one authoritative database
that preserves acknowledged committed intents. A stale binary, deleted/rewound
ledger, split-brain database or loss of committed database state invalidates that
assumption. Redis checks and per-collector caps cannot repair it. Collection must
remain stopped during such uncertainty; this source adds no automatic activation
or environment-based bypass.

The remaining operator policy is how to reconcile an unresolved intent and establish
that its old process cannot resume and its potentially accepted external request has
settled before any separately authorized recovery. No age-based criterion, assumed
provider timeout or operator-reset capability is invented here. Runtime admission
must not be enabled by migration alone without reviewing this operational limit.


## Sibling migration integration

The cost migration and published `jobs_admission_dispatch_001` each name
`audit7_run_policy_001` as parent. They are sibling revisions, not a single chain.
Importing both unchanged creates two heads. Integration must explicitly choose a
reviewed dependency ordering or a merge revision and run the combined additive
migration acceptance. Do not silently reparent, omit a head or stamp over it.
The private spend-cap/refund source revisions are absent from this checkout;
their exact IDs, parents and bytes must be supplied before the full combined DAG
can be verified. Their lineage is not inferred from task names.
