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

## UX-02: source candidate; visual/browser verification pending

The shared console shell now has a compact rail, scrollable selected-module
navigation, stable core links, a friendly account menu and mobile focus/Escape
handling. Policy loading does not replace the entire shell. Legacy APIs shows
personal usage for ordinary users, with no provider usage/billing component
mounted; admin views require current backend identity rather than a stale client
role. Both effective corrected and legacy provider-summary routes enforce the
existing platform-admin guard. Existing cost-only grants retain an owner-bound
admission-backed profile link and cannot access provider administration. No grant
or account was changed. The admission endpoint performs no billing/provider fetch.

Local candidate checks: 48 backend and 18 frontend cases pass, zero skips;
TypeScript and targeted lint pass. Initial tests found a package-router import
mistake and the effective corrected-route entrypoint; both were corrected and
retained. Independent review identified the cost-only navigation regression; its
owner-bound correction has a focused regression. Synthetic desktop/mobile/error
captures and browser interaction remain pending. The disposable preview adds only
the existing owner-scoped GET limits handler, not new effect adapters. No hosted
verification, production change, publication or deployment follows from this entry.


UX-02 browser qualification at ba4b011c078e2465d65e5018b5488f6e1b16ef3c:
8 synthetic actual Next/Auth/BFF browser checks passed: no off-Bullpen requests,
personal APIs without provider fanout, failure distinct from empty success,
permission denial inside shell, mobile keyboard containment/Escape/focus return,
390px no horizontal overflow, 720x450 short reflow and preference restoration.
Screenshots and exact-source receipt remain private under .runtime/uiux-ux02.
Desktop personal/error captures and mobile drawer were visually inspected. The
first mobile capture caught its opening transition; settled capture was inspected.
An initial import-path error prevented browser execution; a subsequent timeout
proved the proxy redirected before the permission page. That source defect was
fixed with a regression, rebuilt, and the full browser check passed. Independent
review found no further concrete boundary issue. Visual review then corrected
legacy unsupported backdrop opacity syntax to explicit bg-black/50; next preview
build will qualify that small CSS correction. Actual browser zoom/screen-reader
and hosted verification were not performed. No PostgreSQL/Redis inference.

UX-01 and UX-02 source/interaction gates accepted for proceeding to UX-03;
remaining broad release/accessibility matrix stays explicit for UX-10/11.

## UX-03: resumable guide; qualification in progress

Added a short, optional guide under Profile / Get started. It preserves all
selections and existing workspace/history, lets one selected module lead, and
links to the supported connection/import, snapshot, research and result screens.
Unavailable selections remain visibly unavailable. UAT2 research/plan navigation
uses the existing confined simulation walkthrough. No grants or effect adapters
were added. Own-app configuration remains in its existing supported setup screen.
Only owner-keyed browser navigation position is saved; refreshing or returning
after session expiry restores that position. It is deliberately not evidence of
connected accounts, accepted holdings, completed research or order consent.

Six focused model/source regressions pass, including foreign/malformed progress,
no financial data in storage, existing destinations and no automatic effects.
Combined shell/guide suite: 16 pass. Existing import integrity tests were also run
for invalid previews, changed inputs, stale parser receipts and owner/session
replacement. TypeScript passed; initial lint caught synchronous effect state,
corrected with the React external-store contract. Final targeted lint passes.
A command initially used incorrect frontend-relative paths and executed no edits;
the corrected command and actual checks are retained separately. Independent
boundary review found no concrete issue. Browser/build and first-use outcome
qualification are still pending; no conversion or unassisted completion claimed.
