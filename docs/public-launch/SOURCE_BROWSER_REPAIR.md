# Explicit synthetic source acquisition repair

Prepared locally after exact `6f3214c9e015f0d3a510cde487318b2ba4fb8cde` CI.
PR Checks run `40021555669` completed with 53 successful jobs and one failed
Webpack/browser job; baseline `40021555705` and API migration `40021555663`
passed. The browser timed out waiting for completed India analysis. The prior
candidate's source guard correctly stopped startup acquisition before module
selection, while the existing browser journey never requested a source after
selection. The private preview's existing encrypted known-fake bindings also
need an explicit fixture verifier; they must not become a hosted credential
fallback. These are source/composition defects, not evidence of slow analysis.

The repair adds an authenticated `POST /runs/analysis-workflows/synthetic-source`
action backed by the shared application acquisition service. Its body permits
only the India portfolio; authenticated identity supplies ownership. Only an
explicit `SyntheticAnalysis` runtime can invoke it. It requires active verified
scope, current module selection, current fake connection and bounded fixed fake
data. No provider, token entry, email or external export is added. An unbound
runtime is unavailable; unknown/client-owner fields are rejected. Selecting a
module still performs no acquisition or analysis automatically.

The browser waits for the actual module PATCH response, then explicitly invokes
this action through the authenticated BFF before starting analysis. It checks
the returned owner, simulation marker and source hash. Existing six-stage,
budget, exact approval, partial/restart and no-replay assertions are retained;
the 90-second completion bound is not relaxed.

The existing network-denied preview supplies a verifier for its exact known
synthetic credential envelopes. It validates owner/connection/version claims and
known fake material, without logging contents. Only the preview scope permits
that callback. Hosted scopes reject any verifier or credential-backed connection
and continue to require their dedicated actual PostgreSQL identity and owner.
There is no real credential or provider fallback and no new persistent key.

Local checks: 84 focused source/HTTP/linked/order-view tests passed with zero
skips; the 20 source-scope/HTTP cases are added to the existing Stage16 CI job
with an exact zero-skip gate. Sixteen browser-evidence contract tests and Node
syntax validation passed. Generated source inventory and route matrix are
updated, including the new route; inventory `--check` passes. No model, migration,
dependency version or deployment change is included.

The fresh local full browser run passed on exact source `159843af20c9ad362d8e307665a8a8601ec7f7a5`,
with served fingerprint bound to that SHA using the unchanged canonical CI
stamp tool. Seven screenshots were retained; six-stage completion,
partial-after-restart and reconciled-filled pages were visually inspected.
The receipt proves explicit authenticated BFF source acquisition after selection,
six governed stages, five settled zero-cost jobs, exact approval, no submission
before approval, two-owner review separation, cancel/disable preservation,
partial restart without replay and durable unknown-to-filled reconciliation
with one fake venue submission. Unknown transition remains durable-store
evidence, not a guaranteed transient-unknown screenshot. Both existing fake
connection modes were exercised; no real provider was contacted.
The source-bound non-sensitive projection and screenshot digests are in
`evidence/source-browser-repair-159843a.json`. Owned preview cleanup succeeded.
An earlier local attempt failed because it omitted the canonical CI fingerprint
stamp and served `development`; its failed receipt and synthetic database were
preserved separately before the fresh stamped run. That attempt is not a pass.
This is local SQLite/real-browser evidence, not PostgreSQL/Redis hosted UAT2
acceptance or public release approval. This documentation successor inherits
no unrun exact-head CI result from the tested code SHA.

The separate local session-policy/worker continuation is excluded from this
repair. No new code was pushed, no UAT2/production action occurred, and no full
hosted or public-release completion follows from this bounded fix.
