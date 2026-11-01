# Session lifecycle proposal and synthetic source evidence

Status: proposed, not approved or implemented. Baseline: main
8d25f34a33242adcaab092afdb07af7956f327bd. PR1391 must land securely
before changes to auth production files. No live credentials, cookies, sessions,
providers, migrations or production services were used for this characterization.

## Tracked outcomes

| ID | Current deliverable | Remaining acceptance |
| --- | --- | --- |
| A9-003-A01 | Explicit proposed contract and migration plan below | Parent obtains lifecycle approval; issuer/audience values and concurrent refresh contract finalized |
| A9-003-A02 | Synthetic verifier tests: intended tokens, expiry, signature; strict expected failures for refresh purpose, missing expiry, wrong issuer | Purpose enforcement at every consumer, inactive user and privacy integration tests after PR1391 |
| A9-003-A03 | Durable schema, transaction, outage and rollout proposal | Approved implementation, migration review and coordinator-managed deployment; no revocation implemented |
| A9-003-A04 | Synthetic shared-flight failure/recovery regression and cache preservation | Full API/BFF/WebSocket contract tests, accessible re-login states, multi-process refresh races and revoked-session checks |
| A9-R01 | Existing cookie selection tests plus private-purge/theme-preservation fixture | Actual synthetic browser HttpOnly/Secure/SameSite/expiry and logout/re-login evidence; source tests do not establish cookie flags |

## Source boundaries

`core/security.py` general verifier does not require purpose, expiry, issuer or
an audience. Refresh tokens declare type=refresh; access tokens omit explicit
purpose. Auth dependencies use that general verifier and check active users.
`auth/router.py` refresh checks type and active user; logout logs activity only;
password reset/change update passwords without durable session invalidation.
`shared/ws_relay.py` and `polymarket_auto_live/router.py` also call the general
verifier directly; they must be included in enforcement review. Existing short
lived one-use WebSocket tickets must stay protected.

`frontend/app/api/bullpen-ai/_lib/serverBackendSession.ts` hashes refresh keys,
coalesces refresh only within one process, bounds refresh to three seconds and
performs one retry after a 401. Process-local coalescing does not solve races
between workers/devices or late requests carrying the previous cookie.
`frontend/auth.ts` omits backend tokens from its browser session callback;
its encrypted JWT session maxAge is 30 days, distinct from backend expiry.
`authSessionCookie.ts` selects a cookie family; it does not set flags.
`privateDashboardCache.ts` purges known private cache prefixes and retains theme.
Browser cache purge is not server revocation.

## Contract requiring approval

Propose ordinary logout revokes only the current session/family. Password reset
and password change revoke all account sessions. Refresh reuse revokes its
family. These semantics are pending the parent's exact user answer; no defaults
are approved by this document.

Propose signed minimal claims: sub, sid, jti, purpose, iat, exp, iss, aud and
account session version; exclude email, financial data and reset secrets.
Access consumers require purpose=access; refresh requires purpose=refresh.
Pin algorithm, expected issuer and audience, require expiry and sensible claims.
Resolve issuer/audience deployment values before rollout, without a weak legacy
fallback. Retain active-user checks and existing cookie protections.

## Proposed durable schema and revocation plan

Use SQLAlchemy and reviewed Alembic migration, not in-memory revocation.
Add User.session_version (non-null integer, initial 0) and AuthSession with
opaque random primary sid, indexed user_id foreign key, version_at_issue,
created_at, expires_at, revoked_at, refresh_generation and current_refresh_digest.
Store keyed digests or irreversible hashes of high-entropy refresh identifiers,
never raw tokens. Add consumed-refresh metadata with a uniqueness constraint on
session/generation if needed to distinguish replay and concurrent retries.
Import models in the repository's model registry. Bound retention by expiry;
do not delete user data automatically.

Every access and refresh request checks active user, account version, session
expiry and revocation against durable storage. Password change/reset atomically
increments version in the same transaction as the password update. Logout
atomically revokes the approved scope. Refresh locks the family row, checks
current generation, consumes it once, commits replacement metadata, then returns
tokens. Concurrent refresh behavior must be approved before implementation:
strict one-time consumption can falsely revoke a valid rotated family when two
BFF workers present the same old credential. A bounded idempotent response
scheme requires a separately reviewed safe replacement-credential mechanism;
never silently accept old credentials or rely on process-local single-flight.

Missing rows, failed storage, unavailable version checks or transaction failures
must never issue tokens or restore sessions. Use a bounded unavailable response
for transient infrastructure failure and a stable re-login response for rejected
credentials; avoid endless refresh retries. Do not log bearer/reset values or
include them in browser projection or URLs. Recheck durable session state when
consuming a WebSocket ticket, and decide how already-open sockets terminate on
revocation; issuance checks alone do not revoke an existing connection.

Coordinator rollout sequence: approve semantics, land PR1391, rebase and rerun
synthetic tests; review additive migration and application compatibility; execute
migration only through authorized operator workflow (repository requires Docker
for Alembic, while production is systemd: coordinator resolves this operational
instruction conflict before execution); coordinate explicit old-token cutover
and approved-identity acceptance; then release enforcement. Old tokens lack sid
and cannot satisfy the new contract. No migration or live invalidation is
authorized by this proposal alone. Rollback must not reinstate revoked sessions.

## Reproducible verification

Python 3 with pytest and python-jose[cryptography]:
`pytest --noconftest -q backend/tests/test_session_contract_characterization.py`.
The isolated class extraction bypasses app initialization and production config;
it does not test dependency wiring. --noconftest avoids unrelated telemetry
fixtures which require the full application environment. Strict xfails are
pending acceptance, not a security pass; remove/rework them after enforcement.

Node 24:
`node --test frontend/tests/auth-session-cookie.test.mjs frontend/tests/session-contract-isolated.test.mjs`.
These use synthetic identifiers and storage only, with no browser or network.
No end-to-end or deployment acceptance is claimed.
