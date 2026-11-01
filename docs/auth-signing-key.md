# Backend JWT signing configuration

The backend requires `JWT_SIGNING_KEY` at settings load, before serving requests.
Supply 32 server-generated random bytes encoded as exactly 64 lowercase hex
characters. Use a server-local CSPRNG; format validation cannot prove entropy.
Missing, empty, whitespace, nonconforming and repeated-pattern keys fail startup.
There is no built-in signing value and no old-key verification fallback.

`JWT_SECRET` and `SECRET_KEY` are compatibility names. Resolution order is
`JWT_SIGNING_KEY`, then `JWT_SECRET`, then `SECRET_KEY`; every supplied name must
be valid and have the exact same value. A blank or conflicting alias fails even
beside a valid canonical key. Prefer removing both aliases and retaining only the
canonical name. Process environment overrides `.env` for the same name, as with
other Pydantic settings; different names still must agree across both sources.
Unrelated runtime entries in a shared environment file are ignored. Signing fields
are excluded from Settings representation and serialization, and validation error
text omits input values. Never log Settings validation error dictionaries or raw
environment contents.

HS256, 15-minute access tokens, 7-day refresh tokens and existing token-purpose
behavior are unchanged. Rotation invalidates all previously signed access and
refresh tokens. Users must sign in again. The server refresh path propagates
rejected refresh credentials; the browser API service signs out on the resulting
401 and redirects to `/login`. This change does not address broader token-purpose
or revocation findings.

## Coordinated production gate

This is a coordinated authentication release, separate from viewer and layout
releases. Do not merge until the coordinator and sole existing local operator have
verified the deployment and rollback gates below. Main pushes trigger production
deployment. A green PR alone is insufficient to authorize that trigger.

1. Verify fresh main and the exact reviewed candidate, checks and independent
   review. Serialize with other releases; keep viewer grants/start held until
   authentication is verified and the owner has signed in again.
2. Read actual loaded units, their EnvironmentFile paths, ExecStart and
   ExecStartPre, and all deployment/rollback commands. The checked-in backend unit
   template invokes `sync-bullpen-operator-credentials.sh` before start, which can
   invoke the Bullpen CLI. Actual recovery units must have the reviewed contained
   behavior; refuse unreviewed hooks. Do not run the ordinary broad redeploy:
   it executes migrations and restarts financial services.
3. Resolve the existing root-owned backend EnvironmentFile privately on the
   server (canonical production path `/etc/investor/backend.env`). The sole local
   operator generates the key there using a CSPRNG and performs a permission-
   preserving private update. Remove legacy aliases, including stale placeholders.
   Never display, hash, log, upload, transmit through chat or commit the key.
   No existing secret retrieval or external credential grants are required.
4. Before starting any promotion, ensure rollback cannot restore fixed-key code.
   The existing workflow recovery trap snapshots and restores the previous source;
   it is unsafe for this first rotation without an explicitly vetted secure
   rollback path. Retain the new private key and reviewed configured-key code on
   failure, or leave the affected services unavailable. Never restore a known
   signing value, old fallback, or pre-remediation authentication artifact.
5. Under the production deployment lock, verify the stopped financial services,
   then promote only reviewed source and restart only the necessary backend and
   isolated recovery processes. Preserve recovery queue policy, units, owner
   boundaries and environment permissions. No migrations, broad deploy, financial
   worker starts, provider calls, trades or paid runs.
6. Verify the loaded revision and readiness, absence of key material in outputs,
   authentication rejection without credentials, and financial services still
   stopped. Have the owner sign in again and verify authorized access before any
   viewer activation. Do not mint production tokens for a test or claim universal
   security from these checks.

The repository-required `aws-secrets-manager` skill was unavailable in the task
environment. The explicitly approved server-local generation route governs this
release; no Secrets Manager retrieval or secret-bearing command was used.

## Local verification

`backend/tests/test_auth_signing_config.py` uses only deterministic synthetic
keys/tokens. It covers configured sign/verify, rotation rejection, algorithm and
lifetime contracts, missing/default/conflicting settings, aliases and `.env`
source precedence, shared-file extras, hidden error inputs, and startup rejection.
The test-suite fixture supplies a synthetic key only to tests; it is not an
application default or a production credential.
