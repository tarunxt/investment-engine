# Synthetic session browser acceptance

Run from the repository root after installing backend requirements in a disposable
venv and `npm ci --ignore-scripts --prefix frontend`. Requires installed Chromium,
OpenSSL, and the **existing session-policy network-none PostgreSQL fixture** at
`/tmp/a9-session-pg-socket-20261103`, database `a9_synthetic`. Never point this
fixture at another database. The GitHub workflow creates/removes that fixture.

```
SESSION_PROOF_PYTHON=/path/to/synthetic/venv/bin/python \
SESSION_PROOF_CHROMIUM=/usr/bin/chromium \
node frontend/tests/session-http-browser/run.mjs
```

The controller creates a temporary source copy (excluding environment files),
adds a fixture page, performs an actual production Next/Webpack build, and runs
real Auth.js, AuthProvider, generic BFF proxy and auth-router code. Two independent
Next HTTPS OS processes share only the existing durable backend store. TLS keys
and encrypted initial browser cookies are disposable synthetic fixtures; they
are never logged or included in receipts. Reauthentication uses the real Auth.js
credentials callback. No providers, emails, workers or production accounts run.

`guard.cjs` is preloaded before application imports; worker sockets are limited
to the three owned loopback ports. The backend installs guards before imports,
permits only the dedicated PostgreSQL Unix socket, and clears inherited config.
Browser page requests outside the two local origins are aborted. The controller
alone may spawn the known build, browser and fixture processes. Receipts contain
only outcomes/counters, process IDs, source commit, browser version and local
paths; temporary TLS/cookie material must never be uploaded. Test failure is a
nonzero exit, with the receipt printed to stdout. `SESSION_PROOF_FILTER` is for
focused diagnosis; CI runs every scenario.

The startup companion imports **actual `app.main`**. `--schema-only` verifies that
missing session tables prevent startup before unrelated initialization. Without
that flag it also attempts the complete actual lifespan and exits nonzero if a
required runtime component is absent. A schema-only pass is **not full startup
acceptance**. No Bullpen executable or credential store is provisioned here.

## Historical independent review

Native read-only reviewer `/root/independent_session_browser_repair_review`
reviewed private repair `563bb4cc78c7b2fc136045d5c8390a371333fe9f` against
`2138b3e6d75a1e8480e84e5b4be01be303657ec7`, finding no definite new defect in
native timer binding, logout-refresh routing or 409 propagation. It verified
23 original archive manifest members and preserved failing cases. This was
source/evidence review, not independent execution. That review predates this
repository-owned reconstruction and does not certify its new CI wiring.
Original archive SHA256:
`5d91b19d7be2927bc2ef14b4ab7f287645554137232a2a305e7c530c56787d3e`.
The executor restart removed the old `/tmp` archive; historical identity is
retained here without claiming that file remains readable.
