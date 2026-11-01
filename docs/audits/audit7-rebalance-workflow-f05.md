# Audit 7 REBALANCE-WORKFLOW-F05

Baseline: `da317a1097cef97089e3a745b9e20b4952af6a48`, fetched from `origin/main`.
Branch: `audit7-f05`. Local implementation only; no production acceptance claimed.

## Revalidation and authorization

The finding remained present at the baseline: `frozen_final.py` checked provenance,
terminal jobs, hashes, identity uniqueness and finite scores, but did not recompute
client arithmetic or reconcile listing counts. Initial strict expected-failure
probes exposed eight classes of accepted client assertions. The initial evidence
commit is `f36e98a4382d6293c9b85e9b475bd68ddc0b2772`.

Work initially stopped at the F04 policy dependency. The coordinator then supplied
the user's explicit approval at 11:36:07 UTC to preserve the configured raw score
and use a separately labelled effective score bounded to -3 through +3 for new
allocation calculations. Historical outcomes and eligibility remain unchanged.
The coordinator subsequently supplied F04's final interface from commit
`fa62a82c30b8bcc09cef4d087e345d6954f6ed77`:
`scorePolicy: "score-matrix-raw-effective-v2"`, `rawScore`, `effectiveScore`;
existing input `score` remains raw. This worker did not modify F04's allocation
eligibility or import its commit into this branch.

## Exact freeze handshake

The workflow writer now explicitly emits:

```text
schema = workflow-final-v2
formula_version = score-matrix-v1
scorePolicy = score-matrix-raw-effective-v2
rows[].score = original raw formulaScore
rows[].rawScore = original raw formulaScore
rows[].effectiveScore = null for unknown raw; otherwise clamp(raw, -3, +3)
rows[].scorePolicy = score-matrix-raw-effective-v2
rows[].formula_inputs.calculatedScore = original raw calculatedScore
```

`formula_version` describes unchanged configured arithmetic; `scorePolicy`
describes the separately approved projection. Scores such as 74/24 remain raw
74/24, with effective score 3. No unversioned value is relabelled or overwritten.

The backend requires this explicit version/policy combination for new captures.
It recomputes from the ownership/revision-checked source responses, not from client
`formula_inputs`. It compares listing membership, input/final counts, exclusions,
valid-source suggestion counts, raw/effective scores, action, estimate, detailed
financial inputs, weighted terms and their validation rules, nested model/summary
row arithmetic, and source identity fields. All existing owner, market/stage,
manifest, terminal-state, source-hash and duplicate-listing gates remain.

Existing saved `workflow-final-v1` snapshots remain readable and immutable. Only
replay against an already terminal stage containing a v1 snapshot may use the old
structural validator; terminal summary merge still preserves the original frozen
facts. New v1 saves and unsupported/mixed version claims are rejected, preventing
a downgrade around independent arithmetic validation. Deploy the updated writer
and backend together; old open tabs require reloading before a new final save.

## Arithmetic preservation

A separate source calculator follows the component's current arithmetic, rather
than reusing the mismatching `recommendation_audit/deterministic.py` policy. It
preserves per-parameter missing-score exclusion, signed weights, explicit
numerator/denominator behavior, Technical confidence's special weights and
out-of-range reduction, trend validation/clamping, mean-action fallback, action
ties, source-derived position means, action mapping, unit changes and market unit
rounding. Formula weights, action scores and denominator retain the UI's finite
numeric domain; no arbitrary audit-calculator bounds or defaults are imposed.

Floating sums follow JavaScript's sequential reduction; comparison permits at
most eight representable floating-point steps (ULPs), rather than a financial or
percentage tolerance. Null, numeric zero and booleans remain distinct. Overflow
fails validation. All calculations use local source copies; source responses,
user formulas, historical snapshots and permission rules are not edited.

The versioned approved setup direction registry is copied from the existing
public frontend constants, checked by a differential test, and also checked
against the captured Technical prompt. No unknown setup direction is guessed.

## Verification

Combined backend command:

```sh
PYTHONPATH=backend /tmp/f05-venv/bin/python -m pytest \
  backend/tests/test_final_score_math.py \
  backend/tests/test_final_recompute.py \
  backend/tests/test_frozen_final_validation_gap.py \
  backend/tests/test_frozen_final_v2_routes.py \
  backend/tests/test_auto_rebalance_audit_durability.py \
  backend/tests/test_recommendation_audit.py \
  backend/tests/test_recommendation_audit_integration.py \
  backend/tests/test_recommendation_audit_recovery.py -q
```

Result: **229 passed**, no xfails or skips. Existing warnings concern passlib/crypt
and SQLAlchemy datetime defaults. The existing durability suite alone passed all
105 tests after installing missing local test dependencies.

The differential test executes actual TypeScript component functions for
consensus construction, score detail, rules, units and estimates, plus the real
setup registry and weighted-score helper. Display-only labels and parsing of
already canonical fixture rows are stubbed. Fixtures cover score boundaries,
positive/negative overflow projection, unknown/missing/zero, malformed and
out-of-range Technical values, fractional trends, missing prices, consensus
amounts, custom weights, explicit zero/negative/large denominators, and fallback.
The subprocess is read-only and uses no API/provider calls.

Real SQLAlchemy/SQLite route fixtures verify accepted raw/effective results,
forged scores/inputs/terms/counts, stale hashes, unsupported versions, schema
downgrade, active-source rejection, partial/error/cancelled Technical behavior,
identical replay and preservation after rejected replay. Existing workflow tests
cover interrupted, cancelled, delayed and repeated persistence flows.

Frontend command:

```sh
node --test frontend/tests/rebalance-stage-inputs.test.mjs \
  frontend/tests/auto-rebalance-audit-persistence.test.mjs \
  frontend/tests/rebalance-workflow-resilience.test.mjs
```

Result: **70 passed**, including four new executions of the actual workflow
callbacks that assert v2 schema, raw/effective projection and null/zero behavior.
This worker did not perform a full-project typecheck or browser UI acceptance.
The integrator must compose F04, run its actual-component browser fixtures and
TypeScript checks against the combined change, and verify applicable live
summary/detail/popup bindings without paid reruns. Local passing fixtures do not
prove production behavior or market correctness.

Initial test attempts lacked pytest, Google packages, psycopg and frontend React;
these were environment dependency gaps, not demonstrated baseline application
failures. Dependencies were installed only in `/tmp` and connected via an ignored
local node_modules symlink. No dependency manifests/settings were changed.

## Acceptance limits

The source adapter deliberately certifies a conservative subset: one canonical
Markdown Rebalance table with unambiguous nonblank cell positions, exact listing
identities and known source actions; canonical Technical tables with an exact
approved primary setup/direction. It rejects ambiguous/multiple tables, escaped
pipes/HTML entities affecting positions, unknown headers/setups, JSON/headerless
layouts, listing aliases requiring interpretation and conflicting equal-time
Technical observations. It does not silently normalize these into signed facts.
Such outputs remain intact and visible, but a new validated final capture fails
with a specific 422 verification error. Extending this subset requires matching
frontend parser fixtures; it must not fall back to accepting client assertions.
Bounds: 20 rebalance runs, 200 source jobs, 500 final listings, 2 MB per source
response/capture. No paid provider/broker run, sync/Refresh, export, mail, credential,
settings, recovery-mode or infrastructure operation was performed. No push, PR,
merge, deployment or publication was performed. Sole integrator owns release and
combined/live acceptance.

## PDF access history

The original handoff supplied an incorrect attachment reference.
Resolved-reference materialization to `/workspace/audit-source` and one bounded
retry to `/workspace/audit-source-retry` returned 404/NOT_FOUND. The coordinator
later explained that version `1` had accidentally been appended to the real ID;
those failures did not establish inaccessibility of the real file.

The coordinator supplied the corrected attachment reference and version.
The complete unchanged canonical search result supplied by the coordinator was
passed to the current skill's download helper, selecting index 000 and using the
executor-local destination `/workspace/audit7-f05-source`. The helper failed before
transfer with: `hosted apps tools/list request failed: network`. Outcome: no PDF
bytes/path returned, no download/install observed. No raw URL or transfer bypass
was attempted. Readable bytes, original SHA256 and actual page 58 pixels therefore
remain unverified by this worker. Source work used the complete exact F05 finding
and preservation map supplied in the handoff plus current repository source.
