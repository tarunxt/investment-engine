# Private session CI integration acceptance — 4 November 2026

Application source: private repair `563bb4cc78c7b2fc136045d5c8390a371333fe9f`.
Published branch read-back before work: `2138b3e6d75a1e8480e84e5b4be01be303657ec7`.
No further production application changes were made in this integration.

Fresh commands, all from the repository root:

```
$PYTHON backend/scripts/verify-session-lifecycle-offline.py
$PYTHON backend/scripts/verify-session-lifecycle-offline.py --run $PYTEST --noconftest -q backend/tests/test_token_purpose_isolated.py
node --experimental-vm-modules --test frontend/tests/session-safe-integration-offline.mjs frontend/tests/session-intent-integration-offline.mjs
$PYTHON backend/scripts/verify-session-postgres-disposable.py
$PYTHON backend/scripts/verify-session-full-startup-offline.py --schema-only
SESSION_PROOF_PYTHON=$PYTHON node frontend/tests/session-http-browser/run.mjs
```

Results: 23 lifecycle, 49 token, 34 Node/BFF, 14 actual PostgreSQL tests passed;
actual main import and fail-closed missing-schema startup passed. The browser
controller's guarded production Webpack/typecheck build passed, then **all nine
scenarios passed in one complete final run**, using Chromium 154.0.8037.57 and
18 separate production Next process IDs (two per scenario). Concurrency observed
200/409, two claims, exactly one refresh. Test bodies/limits were not weakened.
An earlier reconstructed-run reset failure was fixture-only: the controller used
GET for its POST-only reset setup endpoint. The fixture call was corrected and
the entire build/suite rerun. No production route was changed for it.

`$PYTHON backend/scripts/verify-session-full-startup-offline.py` also ran the
**actual complete lifespan**, returning exit 2: the synthetic environment lacks
`/usr/local/bin/bullpen` and `/home/investor/.bullpen`. The unmodified runtime
validator rejected startup. No executable, credential store, fake success,
provider process or production configuration was supplied to bypass it. This
is a local full-startup limit, not evidence of a production failure. The CI
schema-only step explicitly does not claim complete lifespan acceptance.

The harness uses actual cookies, Auth.js callbacks, AuthProvider, generic BFF
proxy, SQLAlchemy store and auth router. Initial fake-account cookies are
fixture-seeded; explicit reauthentication goes through the real credentials
callback. It adds a synthetic page only in a temporary source copy. Its backend
is selected auth routes with synthetic ORM tables, not the complete main app or
a fresh migration acceptance test. Production ingress/TLS/cutover, deployment,
and restored production runtime remain separate acceptance gates.

The committed receipts contain no cookies, JWTs, passwords, TLS keys or account
records. The historical independent review receipt is preserved in the harness
README; its scope did not include this new CI wiring. No new hosted CI run,
remote write, PR metadata update, migration on shared data, or deployment ran.
