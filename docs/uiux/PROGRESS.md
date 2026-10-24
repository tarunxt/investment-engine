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

UX-03 actual local browser qualification at
f7a4fe28465115675b8e183f5f9569c9b9e56e41 passed five checks: refresh,
Skip/Back restoration, rejection of foreign-owner progress, corrected translucent
mobile backdrop, and zero backend mutations during navigation. Mobile guide was
visually inspected. Private receipt/captures: .runtime/uiux-ux03. This does not
establish a first-use conversion rate or new hosted import/research acceptance.

## UX-04: personal dashboard candidate; browser qualification pending

The active dashboard island now loads one personal dashboard instead of the old
duplicate overview/command center. It shows selected cards, masked native money,
truthful absent cash, up to three consequential recorded attention items and a
single prioritized next task. It has no direct Bullpen positions request, combined
INR dependency, empty graphs, automatic research or order effects. Existing legacy
component source remains available for comparison/history, but is not mounted.
Selected-only workflow listing filters portfolios before SQL; explicit core owned
history retains prior semantics. Account/status refresh is read-only. Research
links retain durable workflow anchors and status/version; review is not approval.

Initial focused checks: 28 backend and 15 frontend pass. Independent review found
manual-import readiness ('not_required'), misattributed Bullpen money on other
cards, and truncated history treated as complete. All three were corrected:
accepted manual snapshots qualify source readiness, financial context is limited
to the evidenced India/US projections, and partial/unavailable activity blocks a
new-research next task. Existing backend unresolved-first ordering is preserved.
Focused regression count increased to 16 frontend cases. Final build, type/lint
and synthetic browser qualification remain recorded separately; no hosted claim.

Further UX-04 review corrected normal durable-run links to preserve their anchor
on the actual automated-rebalance analysis screen. It also removed obsolete
empty/unavailable dashboard gate replacements: zero selected modules still mount
core order safety, while unavailable/absent module grants prevent optional data
requests. Tests execute the actual dashboard effect and confirm only the core
safety read occurs for empty/unavailable selections, and late responses after
cleanup cannot update state. Combined dashboard/policy suite: 27 passed. Initial
harness compilation failed due to an injected JSX binding collision, then passed
with proper module imports. Earlier build successes bind to earlier source;
latest candidate still requires its own build/browser receipt. These corrections
do not change any backend grant, owner filter, provider or order effect.

UX-04 browser qualification at facbec1b8869ce5ca00a11ea62a4a08936fc4776:
actual local API returned a retained research result; an initial test incorrectly
assumed this fixture would have unavailable activity and timed out. That failed
receipt is preserved privately. Explicitly injected 503 and UI-only synthetic
summary/truncation fixtures then passed failure/next-task, native currency,
missing-cash, off-Bullpen, read-only refresh and 390px checks. Actual local API
coverage and intercepted UI fixtures are distinct in the private receipt. Desktop
and settled mobile captures were inspected. Bounds confirm 310px cards fit inside
the 390px viewport; an apparent clipped rendering was an image MIME display issue,
not altered screenshot bytes. No hosted/PG/Redis or all-state acceptance claim.

## UX-05: canonical module workspaces; browser qualification pending

Both modules now have a shared persistent header and Overview, Portfolio,
Research, Plans and Activity tabs. Existing holdings/import screens moved to
explicit Portfolio paths with source/history retained. Additional detailed
research views and result histories remain accessible. The old global and module
rebalance launch entry points now navigate to the canonical module research UI;
durable global hash links first verify owner/module access and preserve run
context. No alternate mount starts another workflow. Read lists can explicitly
filter the selected portfolio before SQL. The existing server analysis component
binds its module start and validates owner/portfolio on reads.

US headers say Last import / Manual execution. Its optional resumable checklist
stores only owner/run/source/plan-scoped self-report and never a broker fill or
consent. Historical/unknown input bindings remain read-only. Existing current
input validation is exposed as an optional read-only list projection containing
version/hashes/checked time and orders_authorized=false; it creates no new adapter
or authorization. Actual synthetic SQL tests verify frozen work/status and outbox
counts remain unchanged through current and stale-source readiness reads.

Independent review found stale context surviving tab transitions and older
completed research hiding newer work. Pathname-scoped lifetime replacement,
newest-run priority, settled successful context and matching current server
readiness now gate checklist use. Re-review found no further concrete issue.
35 frontend and 82 backend affected checks pass; TypeScript and targeted lint
pass. Lint initially rejected a local variable named module; it was renamed.
Several commands initially used incorrect frontend-relative paths and performed
no intended writes; corrected commands/checks are retained. Exact-source build,
browser route/Back/account-switch and visual qualification follow separately.
No publication, hosted change, provider effect, actual order or deletion occurred.

UX-05 browser at e4949fc passed actual module Overview/Portfolio/Back and US
import direct refresh, then timed out on legacy alias navigation. A diagnostic
attempt subsequently encountered a local SQLite lock and login HTTP 500, not a
confirmed wrong password. The owned preview was stopped without resetting data
or credentials. Traceback identified the local Stage08 wrapper calling the
updated owner-scoped dashboard without user/db arguments. That wrapper now
passes both and delegates the native accepted-data projection rather than
inventing a fixed US balance. A focused delegation regression and actual scoped
summary suite pass (14 cases). The workflow-list-signature theory was rejected
by source inspection; it was not the diagnosed root cause. Alias and SQLite
qualification remain pending a bounded owned-preview restart. Failed receipts
are retained privately, and are not reported as passing acceptance.

UX-05 final local browser receipt at
251e4b5b14ad4d24c8f9be76d41bacb673f422f1 passed eight checks: actual module
route/Back and US refresh, legacy alias query/hash retention, synthetic checklist
reload and changed-source read-only behavior, 390px layout, no navigation/checklist
backend mutations, and preference restoration verified by read-back. Desktop and
mobile Plans captures were inspected. A prior synthetic snapshot fixture omitted
required holdings fields and crashed that full legacy renderer; it was removed
from that inappropriate test path, not labelled a product regression. The final
metadata-only transition specifically tests stale-checklist protection. Failure
receipts remain private. The owned preview was stopped after qualification.

## UX-06: supported preflight/preview milestone; full candidate modes incomplete

The canonical Research screen now reviews server-owned source and plan hashes,
masked frozen account/mode/version or manual snapshot, source time and actual
usage availability. A deliberate start sends the reviewed hash pair; changes are
rejected before a workflow/outbox is created. Existing six stages and exact order
consent remain unchanged. Unsupported horizon/cash/exposure/turnover controls are
clearly non-configurable, not silently ignored edits.

Paste/CSV preview uses only the three already documented synthetic canonical IDs,
retains raw/row provenance and a versioned digest, identifies duplicates/holdings
overlap/unresolved rows, and rejects malformed or oversized inputs without
truncation (1,000 rows / 100,000 characters). Counts define zero analysed and
resolved-but-deferred candidates; no preview is accepted for analysis. Raw source
is never used as a prompt, URL fetch or instruction. Existing holdings remain a
separate required source. A nonempty draft must be explicitly excluded before a
current-holdings-only start. Owner/source mismatches and late replies fail closed.

Important incomplete scope: Find candidates / shortlist-only / combine-both
analysis, accepted candidate-universe persistence and editable strategy constraints
are absent from the current durable backend contract. The UI disables these modes
and does not call this full UX-06 feature completion. Real canonical catalogue and
provider evidence are unavailable; further synthetic backend mode/constraint
integration remains local implementation work, separately from those external
gates. Current preflight/preview contracts allow the existing holdings-only flow
to be qualified without pretending the new modes execute.

93 affected backend and 16 frontend checks pass, including actual SQL proof that
stale reviewed hashes enqueue nothing, native static route composition, malformed
and malicious CSV, owner separation, explicit review/exclusion and stale preview
aborts. TypeScript and targeted lint pass. Initial lint warning on a numeric
cleanup epoch was corrected with unique lifetime tokens. Independent review
found frozen account details were not displayed; they are now visible and source
shape/time validation fails closed. Re-review found no further concrete issue.
Exact-source build and browser verification remain pending. No new persistent
store, provider call, credential, permission, send, order or deployment was added.

UX-06 actual browser at 0fedf834eeeb748e87288fc2e3ba44ef8bc6a60e correctly
blocked a stale source. A malformed test CSV escaped newlines and produced only
an unaccepted preview; logs confirmed no accept or workflow submission, and the
fixture was corrected. The real browser then previewed/accepted a fresh explicitly
synthetic UATA import, parsed the inert shortlist (including duplicate, unknown
and malicious text), required deliberate draft exclusion and source/usage review,
and started exactly one zero-cost holdings-only workflow. Local workflow 3
completed all six stages and survived reload with no second start. No order/send
request occurred; preferences were restored and read back. Existing source/history
rows were retained, and no hosted account was touched.

Eleven automated browser checks passed, but visual inspection caught a 19px root
overflow from the format select that the container-only assertion missed. The
selector is now constrained to container width and a regression was added. The
original receipt/captures remain private, explicitly visual-unqualified pending
an exact-source root-overflow retest that will reuse the existing run. Four extra
linked source tests cover both fake ownership modes and both owners' real accepted
synthetic imports with all networking/provider factories denied, and prove setup/
preview enqueue nothing. These are SQLite fixtures, not PG/Redis or hosted proof.

## UX-07: durable progress and safe recovery implementation

Six named stages now explain their purpose and checkpoint/attempt counts without
invented percentages. Owner-scoped receipt facts distinguish invalid input,
partial source, policy stop, budget stop, unknown spend, cancellation requested and
completion. Elapsed wall time includes waits/pauses; missing receipts remain
unknown. Stop does not require a budget-store read. Current source/module checks,
complete receipt history and shared server/UI action predicates gate resume/retry.
Independent adversarial review found a pause/resume bypass of typed nonretryable
failures; the shared predicates now close it, with four explicit regressions.
Current-input validation still returns the existing permission failure contract.

Reviewed source/plan/snapshot/module identity yields a stable request key. Owned
lookup occurs before creation, reload can resume existing work, and uncertain
transport recovery retains the same key/body. Lower-version delayed polling cannot
undo accepted controls. Private export recovery stays separate from analysis.
79 backend checks and 26 frontend checks pass; TypeScript and targeted lint pass.
Independent re-review confirmed the bypass closed with all 11 focused progress
checks passing. The initial seven permission-exception regressions and ref-render
lint errors were corrected, not hidden. Local packaged build/browser qualification
is pending; no PostgreSQL/Redis, hosted acceptance or accessibility-user claim.
UX-06 full candidate modes/constraints remain open implementation work.

UX-07 packaged local build at 45fa31852dae45b91630550e06e4eb8b13ead592 passed.
Eight browser checks passed against the actual local Next/Auth/BFF and synthetic
SQLite services: restored prior run 3; explicitly accepted fresh synthetic import;
created only workflow 4; dropped its real creation acknowledgement; recovered that
saved identity without a second POST; reloaded to all six stages completed; checked
390/320px root reflow; no order/send/preferences mutation. Private desktop/mobile
captures and receipt are under .runtime/uiux-ux07; mobile capture inspected. This
is not hosted, PostgreSQL/Redis or unassisted accessibility acceptance. The owned
preview was stopped with existing synthetic source and research history retained.

## UX-08: verified advisory action-plan projection; amendments still open

Plans now load an owner-scoped verified governed receipt with immutable source,
model-plan and result hashes. The screen orders account/mode/date/readiness,
outcome and uncertainty, source-price before/after values, actual proposed rows,
charges/tax limitations, coverage/exclusions, decisions and expandable evidence.
No-change is useful success. Missing prices/cash/fees/tax/order conditions/rationale
stay unavailable; no probability or affordability is invented. Values default
masked; exact quantities remain visible. Save-for-later refers to already durable
history and no-execution is a screen-local decision, explicitly labelled.

INDmoney opens the owner/run/source-bound self-report checklist. India can prepare
an existing exact fake review separately; a ref prevents double requests and the
button remains blocked after any uncertain acknowledgement. No submission occurs.
Independent review caught native journal sources lacking snapshot IDs; the new
readiness predicate instead requires exact server hash/version validation and
current connection identity/version for explicitly synthetic journal receipts.
US imports still require matching accepted snapshot IDs. Historical metadata and
original research evidence remain accessible without permitting a current review.

30 affected backend and 15 frontend checks pass, TypeScript and lint pass.
Initial stale static assertion/syntax and incorrect test working-directory attempts
are retained in private logs; they were corrected, not counted as passes.
Full validated revised-plan amendments and strategy constraints remain incomplete
backend work; controls are blocked rather than silently ignored. Cash is absent
from the frozen analysis source, even though some import models store optional
wallet values; it must not be inferred as zero or borrowed from another account.
Exact-source build/browser qualification and amended-plan safety remain pending.

The first UX-08 packaged browser attempt correctly failed at the local preview
allowlist: the new GET /runs/analysis-workflows/{id}/action-plan was absent. No
business POST occurred. Only that finite numeric read path is added; POST,
DELETE, foreign/non-numeric and nested approval variants remain denied in a new
regression. This changes the local preview boundary, not native activation or
application runtime overrides. The failed receipt/log remain private.

UX-08 packaged build at 24b7142 passed; backend-only preview repair 98d3530
passed 10 focused tests. Seven read-only actual-browser checks at 98d3530 passed:
verified current no-change plan/source values/missing cash, manual checklist,
saved/no-execution choices, stale source history, 390/320px root bounds and seven
material table columns, with zero business POSTs. Mobile screenshot inspection
caught excessively narrow wrapped table columns causing tall rows; a minimum
horizontal table width and explicit scroll instruction are being applied for
follow-up visual qualification. Passing root bounds alone did not qualify that
layout. The owned preview is stopped, and failed first-attempt evidence remains.

## UX-09: distinct exact simulated review and outcome journey

My Activity now separates the read-only exact review gesture from explicit
`Confirm simulated orders`. The displayed basket digest keys that gesture; a
changed digest requires a new review. Account/mode/connection version, every leg,
price/product, gross-notional limits and approval validity remain visible. Existing
server approval, fresh risk, owner authority, fake dispatch and reconciliation
contracts are unchanged. One in-flight confirmation and per-intent uncertain
outcome guards remain in place; no Retry all or residual submission is offered.
Recorded filled/not-recorded-filled quantities are explicitly limited to receipts,
not complete positions/cash. Partial/unknown outcomes require reconciliation;
notification delivery is separate and this view sends no messages.

131 affected backend execution/view checks and 22 frontend checks pass, including
wrong account, changed risk/price/funds, expiry, crash/restart, partial/unknown,
material edits, replay and double-click. These are disposable SQLite/fake tests,
not hosted/PG proof. TypeScript and targeted lint pass. New UI tests verify the
separate review gesture sends nothing and changed digest invalidates it. Packaged
browser qualification and independent review remain pending. UX-06 modes and
UX-08 validated amendments remain explicitly open, not waived by this milestone.
