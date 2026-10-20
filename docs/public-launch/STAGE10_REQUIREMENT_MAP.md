# Stage10 — connection authorization, renewal and disconnect

Authority: complete synchronized `stages/10.md`, “10 · Complete connection authorization, renewal and disconnect”; current parent instruction permits local source/tests/preview only. Base is verified Stage09 `ccb0b3c4682d6bc65c4b38ccf95e71a446dee117`. Parent confirmed independent live Stage09 completion at 15:54:56 UTC on 20 October. Historical HOLD receipts remain preserved and are not current Stage09 state. Stage10 deployment, external publication and Stage11 are not authorized in this phase.

Read root/frontend AGENTS, stages README/current authority, STATUS, RELEASE_GATES and UAT2/acceptance. Frontend client directive guide read from installed Next docs before editing. No Alembic command is run outside a backend Docker container. Schema source can be prepared; actual PostgreSQL migration/rollback remains pending container/CI execution.

## Source inspection and reuse

PR1240 read through GitHub CLI: OPEN, branch `codex/stage01-preview-recovery-20261019`, exact head `ddefd7306003dc8e4e662d3b88abe167da77f036`. Actual changed-file list contains Stage01 docs/inventory/private localhost harness, not Stage10 authorization code. Reuse the inherited supported real Next/FastAPI preview, existing ConnectionStore/IntegrationConnection/ConnectionCredential and module version cancellation controls. No duplicate owner, module or connection registry.

| Requirement | Existing foundation / Stage10 implementation | Acceptance evidence needed |
| --- | --- | --- |
| Both app modes | Stage09 encrypted user-owned material and versioned approved platform credential service; same authorization service for both | Service + actual HTTP + browser synthetic flows; real platform approval separate |
| Short-lived session/connection/mode/app/version bound attempt | New `ConnectionAttempt`, hashed random state and authenticated user/auth_time session generation, five-minute expiry | Wrong state/session/owner, expiry, changed version/app tests |
| Supported callback and allowlist | Exact callback allowlist; Kite `redirect_params` carries state/attempt, not invented redirect_uri | Official docs + roundtrip URL parsing; fake browser callback; live callback untested |
| Atomic consume before server-only exchange | SQL conditional update and durable commit before bounded provider interface call | Replay + independent-connection simultaneous claim; PostgreSQL full callback concurrency pending |
| Account/app identity | Returned api_key, broker and broker user_id validation; broker email deliberately independent from Google email | Wrong app/account identity and different email tests |
| Explicit account/mode review | Encrypted transient candidate; explicit confirm CAS before changing active connection; old identity retained | Fresh current version required, old attempts/approvals invalid, stale module jobs cancellation and schedules paused |
| Failure preservation | No active token change until reviewed candidate is committed | Exchange failure/replay/identity rejection leave old cipher intact |
| Renewal/expiry/revocation/disconnect | Renew attempt; token validation; explicit invalid-token handling; local disable before bounded revoke, separate outcome | Expired/revoked token denial; failed/successful fake revocation; retain reconciliation identity |
| Real UI and synthetic preview | Actual Connections page + authorization component, authenticated BFF and actual API routes, existing network-denied harness | Both modes, review/reconnect/disconnect, reload/mobile/session checks |
| Provider and financial isolation | Default runtime dependency returns503; fake wiring only in private local preview; no credential input or live transport is installed | Default/auth/foreign request denials; no provider approval inferred from fake fixture |

## Official provider contract checked before implementation

Read https://kite.trade/docs/connect/v3/user/ on 20 October 2026. It documents `redirect_params`, one-use short-lived request_token, server checksum exchange, returned api_key/broker/user_id, access token expiry at next 06:00 and DELETE session/token revocation. Secrets/access tokens must stay server-side. Existing live provider service/legacy auth is not modified. This local phase installs only a fake provider interface, so real exchange, registered callback, India 06:00 boundary and provider logout acceptance remain pending; fake one-hour expiry is explicitly synthetic.

## Gate accounting

Code: LOCAL IMPLEMENTATION IN PROGRESS. CI: NOT RUN for Stage10. UAT2 deployment: NOT RUN. UAT2 verification: NOT RUN. Owner acceptance: PENDING Stage10. External provider approval: PENDING, fake approval reference is not provider evidence. Actual PostgreSQL migration/concurrency and independent source review remain required before any Stage10 deployment proposal. No production, old UAT, AWS, credentials, new access, provider or financial action occurred. Existing US$10 allowance and shutdown/retention are unchanged.
