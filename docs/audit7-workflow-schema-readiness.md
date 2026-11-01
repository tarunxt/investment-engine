# Workflow policy schema readiness

The optional workflow policy requires Alembic revision `audit7_run_policy_001`,
which adds nullable JSON `auto_rebalance_workflows.side_effect_policy_json`.
Production schema has not been inspected by this correction. A successful
contained recovery deployment does not prove migrations ran.

History/detail, label reservation, stage updates and completion-email handlers
probe the column without reading rows before workflow work. A specifically
identified missing policy column rolls back the transaction and returns
`503 WORKFLOW_SCHEMA_NOT_READY`. Linked execution/export policy lookups apply the
same failure handling; absent schema cannot authorize legacy side effects.
Existing NULL policies retain existing behavior only when the query succeeds.
Unrelated database errors propagate. No process-wide readiness cache is used.

Dashboard hydration reports failed history reads explicitly and keeps prior
stage evidence; it does not interpret errors as empty history. Saved history and
run-detail views show unavailable errors. The reliability bridge does not replace
this explicit schema error with unrelated fallback output.

Before a separately authorized migration, an operator must confirm the current
revision and a recoverable database backup under the established production
procedure. If the current revision is `recommendation_audit_001`, the narrow
upgrade target is `alembic upgrade audit7_run_policy_001`; verify revision,
column and unchanged legacy rows afterward. Unexpected revisions require review.
The existing recovery deployment intentionally skips migrations. This patch does
not change that driver or authorize migrations, service changes or recovery flag
changes. Reconcile the repository's Docker-only Alembic instruction with the
production no-Docker runtime before execution. Retaining the additive column is
compatible with old code; downgrade deletes policy data and needs separate review
and preservation of those values.
