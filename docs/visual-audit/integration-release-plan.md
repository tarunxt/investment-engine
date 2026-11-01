# Twenty-scope integration preparation

Baseline verified from origin/main: `1089c6f1c5dc01c6cb41be1da7b45e9e7a8b805b`.
Local integration branch: `integration/visual-audit-20`.
The companion JSON records exactly twenty scopes, observed source heads, changed files,
and CI observations. An observed head is provisional until the coordinator confirms it.
All four native source-review batches were received. Actual PDF pixel inspection was
performed by the named native reviewers, not this integrator.

## Release gate

Do not merge to main or deploy until the coordinator supplies verified source-map and
visual acceptance plus the final branch heads for all twenty scopes. DB recovery is a
valid preserve-only scope; do not manufacture a source change. No PR review/approval
submission is authorized by this integration preparation.

## Provisional integration

Fifteen available branches were merged locally with merge commits retaining each
worker's source history. Four implementation refs were absent at initial fetch:
AUTO-MODELS-SELECTION, AUTO-STAGES-HIERARCHY,
VISUAL-MAILS-HISTORY-HIERARCHY, PROMPTS-LIST-DISCOVERY.
Re-fetch before final integration; these may have appeared or advanced.

The only current content conflict was at the import block of
`RebalanceWorkflowSections.tsx`: retain both `InputEvidenceRows`/`InputEvidenceSummary`
and `PromptTemplateDialog`. Resolution commit: `8847241b`.
Stages and Models are expected to touch shared workflow surfaces later; inspect their
final diffs and preserve input summaries, prompt launchers, duration inspection and
all existing stage/execution safeguards.

Scanner CI run `41267340844` failed the frontend dashboard regression job
`124732792241` because a render assertion required `Breakout (Loading…)` in every row.
The scope intentionally moves loading into one shared status. Integration commit
`f9a19e8d` verifies the shared status and not-zero caveat, while retaining error,
confirmed-zero and populated-row checks. The focused file passes 13 tests.
Coordinate this correction with the Scanner worker to avoid duplicate changes.

## Safe verification

- Run the exact frontend dashboard CI suite plus changed-scope tests. Current
  integrated run: 522 tests passed, zero failed or skipped.
- TypeScript `tsc --noEmit` passed. Production `npm run build` (Webpack) passed,
  including generation of all 49 static pages and postbuild runtime-artifact repair.
- Scanner and Bots offline Playwright harnesses passed using system Chromium.
  Scanner: 45 catalogue rows, five columns, shared loading status, sorting, real
  loaded counts/actions, reopen, desktop/narrow, empty, failed/retry and partial
  fixtures. Bots: six source states, three views, keyboard, repeated details,
  four console links, desktop/narrow. Both reported zero external requests.
- The broader test glob initially had 955/969 passing. The untouched baseline
  had 946/959 passing with exactly the same thirteen unrelated failures. The
  sole additional failure was the Scanner assertion fixed in `f9a19e8d`; its
  focused tests and the 522-test required suite pass after that correction.
- Run scope browser harnesses only after checking they bundle real components with
  local fixtures and block external requests. Use system Chromium explicitly where
  a harness otherwise expects an uninstalled Playwright browser.
- Capture 1180x757 at device scale 1 and 390px narrow layouts. Check all applicable
  loading, loaded, confirmed-empty, error, partial and stale states; keyboard tabs,
  dialogs, Escape/focus return, wrapping and all mapped controls.
- Never click real Refresh Board, Run, Sync, order, provider retry, save/delete,
  mail send, connection, account or security actions to generate evidence.
- Preserve compact styling, wider layout, currencies, timezone, arithmetic,
  provenance, source ages, status distinctions, permissions and account footer.
  Report-only navigation, source maps, severity, fixture labels and NOT DEPLOYED
  banners must not become product UI. Historical Sheets outcomes remain history.

## After coordinator acceptance

Re-fetch main and every approved exact head. Reconcile source history and repeat
affected verification after new shared-component changes. Publish a draft integration
PR with exact source-head mapping, conflict resolution and test evidence if needed.
Require applicable PR checks, including production Webpack/runtime checks, to pass.
Use the cloud task-branch PR-to-main release path; production deploy is triggered by
the push to main. Do not dispatch another release prematurely.

Monitor `deploy.yml` for the exact merged SHA through scope detection, artifact build,
runtime verification and rollout. The repository uses production systemd, not Docker;
no infrastructure or environment changes are in scope. Verify the deployed build
fingerprint and coordinator-run passive visual QA against that SHA. Report actual
merge SHA, workflow result and live evidence; no success claim from dispatch alone.

## Access observations

`gh` REST and GraphQL API reads returned Forbidden. Git fetch works, and connected
GitHub workflow tools successfully read CI status/jobs/logs, providing a usable
read-only fallback. No merge, deploy or PR approval was attempted.

## Second source-reconciled preparation

Coordinator-supplied updated heads for Inputs, Duration, Prompt, Mails, Usage,
Preferences, Bots and India were fetched and merged locally without further content
conflicts. Sixteen implementation scopes are now present. Models, Stages and Prompts
remain absent from this integration; Dashboard and US await newer/final head guidance.
DB recovery remains preserve-only. Independent visual acceptance is pending.
The companion `integration-ci-round-2.json` supersedes initial CI observations.

The required 522-test suite and TypeScript passed again. Inputs, Mail History and
Settings recovery browser harnesses passed with no external requests or mutations.
The Mail harness writes its screenshots to tracked paths; these generated outputs
are not worker deliverable changes and are excluded from integration commits.

Sidebar source CI `41267928495` failed runtime JavaScript growth checks after both
builds succeeded. Webpack transferred 236,311 dashboard bytes against a growth limit
of 235,942; its fixed limit is 300,000. Commit `f0fbe924` conditionally loads the
destination directory on demand using Next dynamic import; no budget is increased.
The fixture server was adapted to serve emitted local chunks so it exercises actual
lazy opening rather than replacing the component with an eager mock. Runtime and
keyboard verification results will be recorded after execution.

No denied PR creation or metadata action was retried. Branch inspection and local
integration do not establish approval of the worker's screenshots or clear release.

## All twenty scopes prepared

All nineteen coordinator-supplied implementation heads have now been merged locally;
DB recovery is the twentieth preserve-only scope. Final Dashboard source is
`7e3831ec3f64a4b3d49f230c2ad105c5c12d3607`. Every mapped source commit was verified as
an ancestor of the integration branch. The manifest is authoritative for that mapping.
The latest CI observation snapshot is `integration-ci-round-3.json`; Dashboard's final
head arrived after that snapshot and needs a fresh CI read.

Models and Stages merged cleanly with the updated Inputs and Prompt dialogs.
Scanner's final worker test correction overlapped `f9a19e8d`; merge `5f97a8a8` retains
the worker's equivalent checks, including shared status and not-zero assertions.
Stage Ledger moved the presentation grid into an adapter, invalidating two extraction
fixtures. Commit `fe11713d` supplies the adapter bindings to the audit fixture and
checks the original grid in the adapter. All 37 affected tests passed. Shared workflow
regressions passed 48 tests. Models passed 45 browser checks; Stages passed its
India/US six-row state/keyboard/navigation fixture with zero execution callbacks.

Sidebar on-demand loading ultimately uses React lazy/Suspense (`c1519e52`), retaining
all keyboard, focus, destination, account and preference checks in its offline harness.
The intermediate Next dynamic boundary did not clear the artifact budget.
Exact stamped build `c1519e5216a992a7b4e42026a076c4a4b25d527f` compiled and packaged
successfully. Its fingerprint/auth runtime check reached the dashboard budget gate:
236,323 transferred bytes against 235,942 allowed growth; 762,939 decoded bytes
against 760,197 allowed growth. It failed the transfer gate; no budgets were changed.
This build predates the final Dashboard merge. The integration cannot be released
until the complete final build passes the unchanged runtime budgets and all other
release gates. Sidebar's worker is independently diagnosing its source CI failure.

Exact local logs are in `/tmp/visual-audit-*`; runtime artifact/fingerprint verification
was against a local mock backend, never production. No denied PR creation/metadata
operation, real provider call, live financial action, account mutation, merge to main
or deployment was attempted by this integrator.

Final combined required frontend regression run: **524 passed, zero failed or
skipped** after final Dashboard integration and the Stage Ledger fixture corrections.
Focused integration ESLint passed. Final Dashboard CI `41268566899` is verified
successful at `7e3831ec3f64a4b3d49f230c2ad105c5c12d3607`.
Coordinator confirms all nineteen change branches now have draft PRs, including
Models #1361, Mails #1362, Rankings #1360 and Stages #1363. This integrator did not
retry their previously denied publication actions or optional metadata updates.

## Exact final-head runtime correction

Rebuilt/stamped `5dae09a4390d738766846c2f71366292c3cd7151` reproduced the failure:
Dashboard 236,322 transferred / 762,939 decoded bytes. Build and packaging passed;
the unchanged runtime gate rejected JavaScript growth, confirming the old-artifact
failure was still present on the final integrated source.

Local correction `c928a8863c737a20f8a22e385d77728f681db541` loads existing Appearance
controls only when their disclosure opens. Theme persistence/handlers, account
navigation and permissions are unchanged. The fixture waits for the deferred controls
before asserting their visibility. All sidebar keyboard/focus, routes, footer,
back/forward and zero-write checks pass. Eleven navigation tests and focused lint pass.

The correction's exact stamped Webpack artifact passed the unchanged verifier:
Login 193,809 transferred / 616,448 decoded; Dashboard 235,522 / 759,896;
Bullpen 252,752 / 816,746; Automated Rebalance 713,836 / 2,261,269 bytes.
Fingerprint, authentication boundary, mock backend proxy, route assets and standalone
runtime passed. Budget constants and verifier assertions were not edited.

Fresh integrated fixture screenshots cover Models, Inputs, Stage Ledger, Sidebar,
Preferences inside the corrected Settings shell, and Cost Drivers inside that shell.
Models passed 45 checks, Stage Ledger six-row India/US checks, Inputs both mapped
views and states, Settings narrow wrapping and all controls. All are synthetic local
fixture captures, not production or independent PDF comparisons. Sidebar's supplied
native acceptance applies to its original reviewed branch; integrated acceptance
remains with the coordinator.
