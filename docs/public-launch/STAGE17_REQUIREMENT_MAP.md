# Stage17 — local requirement map

Base: verified Stage16 `4fd362d7bfd32d175a579d5c5c68d69e873d13c3`; qualified prerequisite in STATUS.md. Specification: [17.md](stages/17.md). No host access/deployment or new live authority.

| Requirement | Reuse/change | Evidence/gate |
|---|---|---|
| Public auth bypass/startup/signing | core/security.py, public_service/security.py, main/uat2 lifespan | Test required; source placeholder permitted only development/test. Production requires independent key without reading/logging value |
| Token type/audience/expiry/revocation | JWTUtils; existing session_revocation and Google verifier | Synthetic wrong audience/type/expiry/future claims; logout ledger unchanged |
| Cookie/CSRF/Origin/CORS/WebSockets/body | existing NextAuth+BFF and ws_relay; bounded PublicIngress | Exact frontend origin, chunked cap; existing application request-local guards retained |
| Owner privacy/export/deletion | existing User fence, OutboxMessage, ActivityLog; public_service/privacy/router | Requests persist/cancel/expire. Only synthetic store drill can effect export/deletion. Real full-account scope, retention policy and adapters remain explicit release gates, never counted as approved |
| India eligibility/onboarding | owner-only pending declaration and status; existing ModuleFacts unknown-jurisdiction denial | No email/IP/self-declaration admission; reviewed evidence producer absent; remain fail closed |
| Queue separation/retries/fairness | public_service/operations; existing Orders and Budgets | Pure validated scheduling/retry contract; production Celery routing/consumer rollout remains reviewed runbook gate; no execution replay |
| Monitoring/redacted diagnostics/support | bounded diagnostics and existing AdministrativeRoleGrant/ActivityLog | Correlation UUID/booleans only; real monitoring and support break-glass approval remain external gates |
| Encryption/rotation/restore/rollback | existing ConnectionKeyring and guarded native recovery; drills.py | Synthetic bound encrypted fixtures; no configured key or real backup access; never resume orders |
| Signup abuse, authoritative Google identity | existing unique-email concurrent resolution/standard role/allowlist | Existing regression tests plus independent admission audit; signup quotas remain separate from AI spend budgets |
| Provider/legal/India current requirements | STAGE17_RELEASE_GATES.md | Owner/status/evidence checklist; no application, legal claim or term acceptance |
| Deployment layouts/dependencies | retained UAT2 native/controller receipts and lockfiles | Current production inspection unavailable in this local scope; no architecture replacement, install or dependency upgrades |

Local implementation is not public launch approval. Missing reviewed legal policies, producer bindings, real-effect adapters or operational installation stay gated; synthetic drills do not fill them.


## Local technical closure successor

The earlier rows above describe the reviewed pre-closure candidate and are retained as history. [STAGE17_CLOSURE.md](STAGE17_CLOSURE.md) supersedes their local implementation gaps with actual queue/monitor dispatch, audited support, signup admission, sealed synthetic evidence producer and complete declared synthetic inventory adapters. External bindings and approvals remain disabled/pending. Exact test/source identity is in the closure handoff.
