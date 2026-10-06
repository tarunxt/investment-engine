# JWT signing key configuration and rotation

## Release prerequisite

The backend requires `JWT_SECRET_KEY` in its runtime environment. The value must
be a newly generated, cryptographically random 32-byte secret encoded as exactly
64 hexadecimal characters, without spaces or a trailing newline. Repeated
placeholder patterns are rejected. Format checks cannot prove randomness; the
operator must generate the secret securely.

This is the shared HS256 signing secret for backend access and refresh tokens.
It is separate from the frontend's `NEXTAUTH_SECRET`. Do not reuse either the
previous public signing value or another service's credential. `SECRET_KEY` and
`JWT_SECRET` are not aliases and cannot enable signing. There is no generated,
development, auth-disabled, or old-key fallback.

Do not merge/deploy this change until the operator has installed the new value.
Missing or invalid configuration stops the backend and Celery processes at
startup. `deploy/no-docker/redeploy.sh` runs the same JWT validation during its
environment preflight, before its own systemd changes, migrations, or service
restarts. It fails without printing the value if configuration is missing or
invalid.

This inner preflight is not a no-mutation guarantee for the full deployment
workflow. `.github/workflows/deploy.yml` can run
`configure-postgres-recovery.sh --restart-backend` before invoking `redeploy.sh`.
Validate signing configuration independently before triggering that workflow,
and resolve storage, database-recovery, and worker-safety blockers first. A
full-stack release restarts backend workers and beat; do not treat this change
as an authentication-only restart or deploy while financial tasks are unsafe to
interrupt.

## Secure operator entry

1. Generate a fresh secret using a trusted local password manager or a
   cryptographically secure generator in a private terminal. Keep its value out
   of chat, source control, workflow inputs, command-line arguments, screenshots,
   and logs. Do not use any deterministic test fixture from this repository.
2. On the production host, use the approved privileged editor to add or replace
   `JWT_SECRET_KEY` in `/etc/investor/backend.env`. The operator enters and saves
   the value themselves. Do not place it in `/etc/investor/frontend.env` or a
   `NEXT_PUBLIC_*` variable. Preserve the environment file's restrictive access.
3. All backend instances and backend task services must receive the same new
   value. For local Docker deployments, set it in the untracked runtime `.env`
   consumed by the backend and Celery containers; production Compose uses
   `.env.prod`. The checked-in environment
   examples deliberately leave it empty.
4. Validate configuration against the repaired release before restarting
   services. Use the normal backend service identity, environment-file loader,
   and Python interpreter. Run
   `python3 backend/app/core/jwt_configuration.py` from the repaired checkout;
   this dependency-free check prints only `JWT configuration valid` on success.
   It validates the environment already loaded in that process without reading
   an additional file. Never print the settings object, environment, key, key
   fingerprint, or tokens. The check exits nonzero for invalid configuration.
   Do not enable shell tracing (`set -x`) for this operation.
5. Coordinate the release so every backend instance runs the repaired code.
   Existing instances using the old code remain vulnerable until replaced.
   Deploy using the normal release process and verify `investor-backend` and
   all deployed `investor-celery-*` services are healthy. This change requires no
   database migration.

## Authentication checks after rollout

- Existing access and refresh tokens must be rejected. Everyone must log in
  again; the frontend session alone cannot refresh an old backend token.
- A fresh login should return the existing response shape and a working access
  token. Refreshing that fresh session should work normally.
- Check a protected API request and the websocket ticket flow with the new
  session. Do not copy authentication tokens into reports or logs.
- Confirm every API instance has switched before considering the incident
  contained. Merely adding an environment value to a host still running the
  old hardcoded-key code does not fix it.

## Rollback and later rotations

Never roll back to code with the public hardcoded signing key or enable the old
key as a fallback. If rollout fails, repair the configuration or roll forward
with the security fix retained; do not restore unsafe authentication to recover
availability. Preserve the new credential during unrelated code rollbacks.

For a later rotation, the operator replaces `JWT_SECRET_KEY` everywhere and
restarts all consumers together. There is a single active signing key and no
old-key grace period, so all existing access and refresh tokens are invalidated.

## Regression verification

`backend/tests/conftest.py` sets a public deterministic test-only key before
application imports. The runtime application never loads that test file.
`backend/tests/test_jwt_signing.py` verifies mandatory configuration, safe error
and settings output, missing-key startup failures, unchanged token claims and
lifetimes, signature/algorithm/expiry checks, and both token types becoming
invalid after a signing-key change. Other non-pytest smoke processes that import
backend settings need an explicitly supplied test-only key in their isolated
test environment.

The disposable API attempt migration verifier supplies its own public,
deterministic signing fixture after checking the exact CI/container environment.
It replaces any inherited signing value rather than forwarding host credentials.
Its offline regression test imports the complete model registry in a fresh
process using that sanitized environment; the PostgreSQL roundtrip remains a
separate container-only check.
