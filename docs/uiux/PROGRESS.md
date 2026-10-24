# UI/UX prompt progress

These are UX-00 through UX-11 from the 24 October 2026 UI/UX pack, separate
from engineering stages 00–20. Local implementation does not authorize publication,
deployment, provider activation, account/role changes or financial effects.

## UX-00: inventory accepted for implementation

Read the complete prompt text and all 28 pages of extracted blueprint text through
Library. Original-file downloads on the consuming Mac failed twice per file;
no further retry or transfer workaround was used. Mac-local original bytes and a
local PDF render remain unavailable. The blueprint is textual specification and
tables; no embedded source screenshots are claimed inspected. Private inventory
and 21 synthetic owner/admin policy fixtures are retained outside this repository.
Existing baseline: 32 frontend and 34 backend checks passed, zero skips.

Confirmed code findings: unguarded direct Bullpen dashboard fetch, hardcoded
unselected portfolio metrics/FX copy, incompletely scoped cache fallback, policy
failure hiding navigation, and usage error rendering alongside an empty-success
message. The APIs route already mounts the shared shell; a missing layout is not
an established screenshot root cause. No fresh hosted symptom reproduction.

## UX-01: local source and focused checks passed

Selected visibility is separate from availability/read authority. Selected but
disconnected/unavailable modules retain setup/status surfaces without fetching
data. Core navigation survives missing policy. Normal and dedicated UAT2 summary
loaders omit unselected modules before queries; INR-only scope does not load FX.
The native US summary reuses the owner-filtered accepted-import projection.

Bullpen fetch/mount/manual refresh is guarded by current capability and revocable
request scope. Dashboard metrics, history/error/FX projections and cache identities
are owner/session/policy scoped. Initial server data carries an authenticated
owner/session/policy binding and is rejected before hydration/cache seeding when
any binding differs. Independent review identified this retained-SSR gap; the
correction and regression were reviewed without further concrete findings.

Final local results: 60 backend checks; 41 frontend checks; TypeScript and targeted
ESLint pass, zero skips/errors/warnings. Earlier runs retain a type-shape error,
stale behavior assertions and corrected command working-directory failures; they
are not relabelled as initial successes. No actual browser/host/PG/Redis run was
performed for this package. New request/aggregate regressions are synthetic unit
and SQLite/fixture evidence. Broader visual acceptance and CI wiring remain for
the later packages. Existing ownership, broker approval and simulation fences
remain authoritative. No user data, credentials, permissions or live settings
were changed.

Rollback: revert this package's source commit locally; no schema migration or data
rollback is required. Legacy history remains in its original stores. Continue with
UX-02 shell/role separation, then the remaining prompts in their supplied order.
