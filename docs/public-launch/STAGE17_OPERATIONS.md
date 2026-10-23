# Stage17 — reviewed operational procedures, no automatic execution

Current UAT2 is stopped. These files do not authorize restart, spending, security or production changes. Preserve existing dedicated native systemd/controller stack; no Docker rebuild or parity mandate. Actual host layouts/network controls were not freshly inspected. Historical native receipts remain evidence of their recorded state only.

## Queue and incident policy

`public_service.operations.POLICIES` separates AI(2total/1owner), financial execution(1/1) and reconciliation(1/1), prefetch1, explicit attempt/time bounds. These are reviewed local admission contracts, not an installed worker configuration. Existing Stage13 durable SpendAttempt reservations/fair SQL admission remain authoritative for AI; Stage14/15 intent locks, fill/funds guards and uncertain reconciliation remain authoritative for orders. No new worker task/Beat schedule or dispatch binding is installed. The operator must map actual tasks/consumer units to these policies and validate capacity before rollout; unbound policies cannot be counted as live isolation.

Unknown financial outcome: freeze new dispatch with the existing authenticated emergency-stop/module controls; preserve intent/attempt/approval/outbox/backup evidence. Reconciliation observes the original account/order identity and never creates a new order. Do not mark timeout as safe failure, reset idempotency, clear pending recovery markers manually, or replay after restore. Any changed payload/account/risk/instructions needs a fresh review and exact confirmation. Retry contracts refuse uncertain execution/AI effects; only the separate read-only reconciliation lane may retry within bounds.

Monitor stale source age, unknown orders and spent+reserved cost against approved caps. `diagnostics()` emits only a validated correlation UUID and boolean alarms, never email, holdings, request bodies, provider output or credentials. Alerts require an approved sink and operator acknowledgement; no real notification is configured here. On a cost spike preserve held uncertain reservations; stop further admission rather than erasing them. Metrics collection/cadence/sink are deployment gates, not inferred from these pure contracts.

## Operator and support access

Reuse `AdministrativeRoleGrant`, `require_platform_admin`, cost-reader scope and `ActivityLog`; no new default admin or cross-tenant support read. Support starts with owner-supplied redacted receipt IDs and correlation ID. Owner consent, named operator, purpose/ticket, exact resource scope and expiry are required before separately authorized break-glass access. Record actor/subject/action/decision/time/correlation in durable audit before access; deny if audit cannot persist. Existing cost-reader role is not platform or privacy administration. No support impersonation/access-grant endpoint is added. Approval and support-audit retention are pending release gates; do not paste secrets into tickets.

## Privacy requests and retention

Owner-only APIs `/account/operations/eligibility` and `/account/operations/privacy-requests` record status behind authentication. Do not expose user-ID parameters. Requests bind owner/kind/idempotency key, support cancellation, have bounded lifetime and remain `retention_review_required`. They reuse User row locks, existing outbox and ActivityLog. Only an explicitly injected exact SyntheticPrivacyStore operates on synthetic records; no real eraser, export destination, filesystem path or adapter fallback exists. Legal holds, full-account inventory/export format, backup handling, retention schedule and verified real adapters require separate review. No synthetic drill result may be presented as actual user deletion/export.

Residency declarationIN is pending review and never supplies allowed ModuleFacts jurisdiction. Existing default module facts therefore remain fail closed. Future reviewed evidence must be versioned, owner-bound, dated, revocable and checked at each boundary. No email, IP, timezone, Google profile or self-declaration is residence proof.

## Encrypted backup/key rotation and rollback drills

Reuse `ConnectionKeyring` for explicit version selection/no trial-key fallback. `drills.py` accepts only synthetic documents and caller-supplied ephemeral fixture keyrings; it cannot fetch runtime secrets or open host files. Seal owner/source/hash inside authenticated ciphertext. Verify old snapshot, rotate to new version, restore with the new key, reject owner/source/tamper/missing-version changes; keep old keys until all required retained backups are verified, never retire them automatically. Record hashes/version/receipt only, never keys/plaintext. Actual encrypted database backup infrastructure and operational rotation need separate owner approval and receipt.

Native rollback remains existing guarded controller: stopped applications, verified backup provenance/schema/data/sequences, strict pending marker, atomic promotion/readiness and bounded fail-closed recovery. Restore must not resume workflows or replay outbox/order effects; require authoritative reconciliation and fresh user confirmation. Use exact existing source/controller/helper/unit/package pin and approved maintenance bound. Do not run host restore/drills from this local stage.

## Auth rollout and dependencies

Public startup now requires independent JWT_SIGNING_KEY(not source placeholder), authentication enabled,debugfalse and HTTPS frontend; restricted UAT2 keeps its separate key/audience. Missing keys fail closed; the change must not be deployed until existing operator-managed configuration is reviewed without reading secret values. Existing access sessions without explicit new type/audience are rejected; plan controlled reauthentication, never mint compatible unsigned/legacy fallback tokens. Preserve Google authoritative email/disabled users/standard-role defaults and independent Sheets config. Signup/abuse controls are a distinct readiness gate from module budgets; ingress limits alone are not abuse protection. Dependency locks are unchanged; no installation, upgrade or vulnerability-feed claim was made. Pin an approved dependency audit before public release.


Local closure update (21 October 2026): working implementations and the distinction between local controls, disabled external bindings and real-world approvals are recorded in [STAGE17_CLOSURE.md](STAGE17_CLOSURE.md). Earlier contract-only descriptions above are historical for cf2ddfd and do not describe the new successor. No external approval, activation or deployment has occurred.
