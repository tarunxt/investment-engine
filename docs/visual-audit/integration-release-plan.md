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
